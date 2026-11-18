import { IResult, Result, ValueObject } from '@Architecture/Domain';

import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  InvalidOriginalRateException,
  OriginalCurrencyIsGroupCurrencyException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The currencies Tally knows, in Ledger's words (request 2): the same six codes Groups creates a group in. */
export const ORIGINAL_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

/** What the payer of an expense in another currency states: the currency, the amount in its hundredths, and the rate as written. */
export interface OriginalDraft {
  readonly currency: string;
  readonly amount: number;
  readonly rate: string;
}

/** The rate has at most six digits after the point (request 21); it is scaled by 10^6 to be read in exact integers. */
const RATE_PATTERN = /^\d+(\.\d{1,6})?$/;
const RATE_SCALE = 1_000_000n;
const MAX_ORIGINAL_AMOUNT = 100_000_000;

/**
 * What an expense in another currency was paid in (request 21, the storm's OriginalAmount): its currency, its amount in that
 * currency's hundredths, and the rate its payer states, one of that currency is worth in the group's, kept as the string it was
 * given. The amount in the group's currency is the original amount times the rate, rounded to the nearest whole number, a half
 * rounded up, computed in exact integers (a rate is read as a whole number of millionths), never in floating point. The value
 * refuses a currency that is not Tally's or is the group's own, an amount that is not from 1 to 100 000 000, and a rate that is
 * not a positive decimal with at most six digits after the point: each by its own name (DOMAIN-RESULT).
 */
export class OriginalAmount extends ValueObject<OriginalDraft> {
  private constructor(value: OriginalDraft) {
    super(value);
  }

  /** The original amount, decided against the group's currency. Records nothing, reads nothing. */
  static decide(draft: OriginalDraft, groupCurrency: string): IResult<OriginalAmount> {
    if (!(ORIGINAL_CURRENCIES as readonly string[]).includes(draft.currency)) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (draft.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    if (!Number.isInteger(draft.amount) || draft.amount < 1 || draft.amount > MAX_ORIGINAL_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (scaledRateOf(draft.rate) === undefined) return Result.fail(new InvalidOriginalRateException());
    return Result.ok(new OriginalAmount({ ...draft }));
  }

  /**
   * An original amount as the store keeps it: decided when it was recorded, so it is read back as given. Records nothing, and
   * throws on a value the domain never keeps.
   */
  static kept(draft: OriginalDraft): OriginalAmount {
    if (scaledRateOf(draft.rate) === undefined) throw new Error(`The rate of an expense is corrupted: ${draft.rate}`);
    return new OriginalAmount({ ...draft });
  }

  get currency(): string {
    return this.value.currency;
  }

  get amount(): number {
    return this.value.amount;
  }

  /** The rate exactly as its payer wrote it. */
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

  protected override equalsValue(a: OriginalDraft, b: OriginalDraft): boolean {
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
