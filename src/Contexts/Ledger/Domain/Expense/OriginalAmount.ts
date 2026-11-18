import { IResult, Result, ValueObject } from '@Architecture/Domain';

import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  InvalidOriginalRateException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
  RateOutsideBandException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The currencies Tally knows, in Ledger's words (request 2): the same six codes Groups creates a group in. */
export const ORIGINAL_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

/**
 * What the payer of an expense in another currency gives (request 21, request 22): the currency, the amount in its hundredths, and
 * the rate as written, or none, when the rate offered for the currency on the day is taken.
 */
export interface OriginalDraft {
  readonly currency: string;
  readonly amount: number;
  readonly rate?: string;
}

/** What an expense in another currency keeps (request 21): the currency, the amount, and the rate it was recorded at, as a string. */
export interface OriginalRecord {
  readonly currency: string;
  readonly amount: number;
  readonly rate: string;
}

/**
 * What the rates service offers for a currency to the group's on a day (request 22, the storm's OfferedRate), as the port answers it:
 * the rate as the service wrote it, or no rate (the service has none, or did not answer well, or in time), or no rates service at all
 * (`RATES_URL` is not set), which takes the payer's rate as request 21 does. A plain value, read by the decision (DOMAIN-NON-DETERMINISM).
 */
export type OfferedRate =
  { readonly kind: 'rate'; readonly rate: string } | { readonly kind: 'none' } | { readonly kind: 'no-service' };

/** The rate has at most six digits after the point (request 21); it is scaled by 10^6 to be read in exact integers. */
const RATE_PATTERN = /^\d+(\.\d{1,6})?$/;
const RATE_SCALE = 1_000_000n;
const MAX_ORIGINAL_AMOUNT = 100_000_000;
/** The band a stated rate may be within of the offered one, in percent (request 22): 2 % of the offered rate, inclusive. */
const BAND_PERCENT = 2n;

/**
 * What an expense in another currency was paid in (request 21, the storm's OriginalAmount): its currency, its amount in that
 * currency's hundredths, and the rate, one of that currency is worth in the group's, kept as the string it was given or taken. The
 * amount in the group's currency is the original amount times the rate, rounded to the nearest whole number, a half rounded up,
 * computed in exact integers (a rate is read as a whole number of millionths), never in floating point.
 *
 * `decide()` is given the rate the rates service offers for the currency on the day (request 22). A rate the payer states is kept
 * when no service is configured (request 21), and when the service offers one, it must be within 2 % of the offered rate, inclusive
 * (`RateOutsideBand` otherwise); with no rate offered, nothing can be checked, so a stated rate is refused (`NoRateOffered`). A rate
 * left out takes the offered rate, and is refused when there is none. The value refuses a currency that is not Tally's or is the
 * group's own, an amount that is not from 1 to 100 000 000, and a rate that is not a positive decimal with at most six digits after
 * the point, each by its own name (DOMAIN-RESULT).
 */
export class OriginalAmount extends ValueObject<OriginalRecord> {
  private constructor(value: OriginalRecord) {
    super(value);
  }

  /** The original amount, decided against the group's currency and the offered rate. Records nothing, reads nothing. */
  static decide(draft: OriginalDraft, groupCurrency: string, offered: OfferedRate): IResult<OriginalAmount> {
    if (!(ORIGINAL_CURRENCIES as readonly string[]).includes(draft.currency)) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (draft.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    if (!Number.isInteger(draft.amount) || draft.amount < 1 || draft.amount > MAX_ORIGINAL_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    const rate = rateOf(draft.rate, offered);
    if (rate.isFailure()) return Result.fail(rate.error);
    return Result.ok(new OriginalAmount({ currency: draft.currency, amount: draft.amount, rate: rate.data }));
  }

  /**
   * An original amount as the store keeps it: decided when it was recorded, so it is read back as given. Records nothing, and
   * throws on a value the domain never keeps.
   */
  static kept(record: OriginalRecord): OriginalAmount {
    if (scaledRateOf(record.rate) === undefined) throw new Error(`The rate of an expense is corrupted: ${record.rate}`);
    return new OriginalAmount({ ...record });
  }

  get currency(): string {
    return this.value.currency;
  }

  get amount(): number {
    return this.value.amount;
  }

  /** The rate exactly as its payer wrote it, or as the rates service wrote it when it was taken. */
  get rate(): string {
    return this.value.rate;
  }

  /**
   * The amount in the group's currency's hundredths: the original amount times the rate, rounded to the nearest whole number, a
   * half rounded up. It may fall outside 1 to 100 000 000; the expense refuses that, not this value.
   */
  toGroupAmount(): bigint {
    const scaled = scaledRateOf(this.value.rate) as bigint;
    return (BigInt(this.value.amount) * scaled + RATE_SCALE / 2n) / RATE_SCALE;
  }

  protected override equalsValue(a: OriginalRecord, b: OriginalRecord): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}

/**
 * The rate an original is kept at (request 21, request 22): the one stated, when there is no service or the offer is within 2 % of
 * it; the offered one when none is stated. Refused by name when the stated rate is not a positive decimal, when no rate is offered,
 * or when the stated one is outside the band.
 */
const rateOf = (stated: string | undefined, offered: OfferedRate): IResult<string> => {
  if (stated === undefined) {
    if (offered.kind === 'rate' && isPositiveRate(offered.rate)) return Result.ok(offered.rate);
    return Result.fail(new NoRateOfferedException());
  }
  const scaled = scaledRateOf(stated);
  if (scaled === undefined) return Result.fail(new InvalidOriginalRateException());
  if (offered.kind === 'no-service') return Result.ok(stated);
  const reference = offered.kind === 'rate' ? scaledRateOf(offered.rate) : undefined;
  if (reference === undefined) return Result.fail(new NoRateOfferedException());
  const difference = scaled > reference ? scaled - reference : reference - scaled;
  if (difference * 100n > reference * BAND_PERCENT) return Result.fail(new RateOutsideBandException());
  return Result.ok(stated);
};

/** Whether a rate is a positive decimal with at most six digits after the point, as Tally reads one (request 21, request 22). */
export const isPositiveRate = (rate: string): boolean => scaledRateOf(rate) !== undefined;

/** The rate in millionths, or `undefined` when it is not a positive decimal with at most six digits after the point. */
const scaledRateOf = (rate: string): bigint | undefined => {
  if (!RATE_PATTERN.test(rate)) return undefined;
  const [whole, fraction = ''] = rate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(6, '0'));
  return scaled > 0n ? scaled : undefined;
};
