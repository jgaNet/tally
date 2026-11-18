import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { Currency, convertMinorUnits } from '@SharedKernel/Domain';

import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * What is paid in another currency (request 39): the currency, the amount in its hundredths, and the rate the rates service offers for
 * the currency to the group's on the day it is decided, as it wrote it, or none when it offers none. The payer gives no rate.
 */
export interface OriginalDraft {
  readonly currency: string;
  readonly amount: number;
  readonly offered: string | undefined;
}

/** What a settlement in another currency keeps (request 39): the currency, the amount, and the rate it was decided at, as a string. */
export interface OriginalRecord {
  readonly currency: string;
  readonly amount: number;
  readonly rate: string;
}

/** The rate has at most six digits after the point (request 22); it is scaled by 10^6 to be read in exact integers. */
const RATE_PATTERN = /^\d+(\.\d{1,6})?$/;
const MAX_ORIGINAL_AMOUNT = 100_000_000;

/**
 * What a settlement was paid in, when it is paid in another currency (request 39, the storm's OriginalAmount): its currency, its amount in that
 * currency's hundredths, and the rate, one of that currency is worth in the group's, kept as the string the rates service wrote. The amount in
 * the group's currency is the original amount times the rate, rounded to the nearest whole number, a half rounded up, in exact integers
 * (a rate is read as a whole number of millionths), never in floating point. The provider's fee in that currency converts the same way.
 *
 * `decide()` is given the rate offered; with none, the settlement is refused by name (`NoRateOffered`), and so is a currency that is not
 * Tally's or the group's own, or an amount that is not from 1 to 100 000 000 (DOMAIN-RESULT). It is a value the settlement keeps, read back as given.
 */
export class OriginalAmount extends ValueObject<OriginalRecord> {
  private constructor(value: OriginalRecord) {
    super(value);
  }

  /** The original amount, decided against the group's currency and the offered rate. Records nothing, reads nothing. */
  static decide(draft: OriginalDraft, groupCurrency: string): IResult<OriginalAmount> {
    if (!Currency.isCode(draft.currency)) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (draft.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    if (!Number.isInteger(draft.amount) || draft.amount < 1 || draft.amount > MAX_ORIGINAL_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (draft.offered === undefined || scaledRateOf(draft.offered) === undefined) {
      return Result.fail(new NoRateOfferedException());
    }
    return Result.ok(new OriginalAmount({ currency: draft.currency, amount: draft.amount, rate: draft.offered }));
  }

  /**
   * An original as the store keeps it: decided when it was made, so it is read back as given. Records nothing, and throws on a value the
   * domain never keeps.
   */
  static kept(record: OriginalRecord): OriginalAmount {
    if (!Currency.isCode(record.currency))
      throw new Error(`The currency of a settlement is corrupted: ${record.currency}`);
    if (scaledRateOf(record.rate) === undefined)
      throw new Error(`The rate of a settlement is corrupted: ${record.rate}`);
    return new OriginalAmount({ ...record });
  }

  get currency(): string {
    return this.value.currency;
  }

  get amount(): number {
    return this.value.amount;
  }

  /** The rate exactly as the rates service wrote it. */
  get rate(): string {
    return this.value.rate;
  }

  /** What the settlement keeps of it: a plain copy of the record. */
  toRecord(): OriginalRecord {
    return { ...this.value };
  }

  /**
   * The original amount in the group's currency's minor unit: the amount, read in its own currency's minor unit, times the rate, written in the
   * group's, rounded to the nearest whole number, a half rounded up (request 40). The settlement's amount is this (request 39); the provider's fee
   * converts through `groupAmountOf` the same way.
   */
  toGroupAmount(groupCurrency: string): number {
    return this.groupAmountOf(this.value.amount, groupCurrency);
  }

  /** `minorUnits` of the original currency, converted to the group's currency at the rate of this value, rounded half up (request 39, 40). */
  groupAmountOf(minorUnits: number, groupCurrency: string): number {
    const scaled = scaledRateOf(this.value.rate) as bigint;
    return Number(convertMinorUnits(BigInt(minorUnits), this.value.currency, groupCurrency, scaled));
  }

  protected override equalsValue(a: OriginalRecord, b: OriginalRecord): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}

/** The rate in millionths, or `undefined` when it is not a positive decimal with at most six digits after the point. */
const scaledRateOf = (rate: string): bigint | undefined => {
  if (!RATE_PATTERN.test(rate)) return undefined;
  const [whole, fraction = ''] = rate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(6, '0'));
  return scaled > 0n ? scaled : undefined;
};
