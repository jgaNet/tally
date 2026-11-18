import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain/Currency';

import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  InvalidRate,
  SameCurrencyAsTheGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense was paid in, as its payer gives it: a currency, an amount in its hundredths, and the rate as a string. */
export interface OriginalAmountInput {
  currency: string;
  amount: number;
  rate: string;
}

/** An expense's money as it is given: its amount in the group's currency, or what was paid in another currency (request 21). */
export type MoneyInput = { amount: number } | { original: OriginalAmountInput };

/** A decimal number above 0 with at most 6 digits after the point, written as the payer gave it: `"0.9542"`, `"1"`, `"12.5"`. */
const RATE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept to 6 digits after the point: the exact arithmetic multiplies by 10^6. */
const RATE_DIGITS = 6;
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS);

interface Original {
  currency: CurrencyCode;
  amount: number;
  rate: string;
}

/**
 * What an expense was paid in, in a currency other than its group's: the currency, the amount in that currency's hundredths
 * (1 to 100 000 000), and the rate, what one unit of that currency is worth in the group's currency. The rate is kept as the
 * string given, so it is read back as it was stated. The amount in the group's currency is computed here, once, in exact
 * integer arithmetic: never in floating point, where a half would not be a half.
 */
export class OriginalAmount extends ValueObject<Original> {
  static readonly MIN = 1;
  static readonly MAX = 100_000_000;

  private constructor(value: Original) {
    super(value);
  }

  /** Decides what was paid: a currency of Tally's other than the group's, an amount in its range, and a rate that is valid. */
  static create({ currency, amount, rate }: OriginalAmountInput, groupCurrency: CurrencyCode): IResult<OriginalAmount> {
    if (!isCurrencyCode(currency)) return Result.fail(new InvalidOriginalCurrency());
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsTheGroup());
    if (!validAmount(amount)) return Result.fail(new InvalidOriginalAmount());
    if (!validRate(rate)) return Result.fail(new InvalidRate());
    return Result.ok(new OriginalAmount({ currency, amount, rate }));
  }

  /** Re-reads what was kept: the same rules as `create`, without the group's currency, which a kept expense does not repeat. */
  static restore({ currency, amount, rate }: OriginalAmountInput): OriginalAmount | null {
    if (!isCurrencyCode(currency) || !validAmount(amount) || !validRate(rate)) return null;
    return new OriginalAmount({ currency, amount, rate });
  }

  /**
   * The amount in the group's currency: the amount times the rate, rounded to the nearest whole number, a half rounded up. It is
   * an exact integer computation, so 1000 at "0.9545" is 954.5 and so 955, and 1234 at "1.0625" is 1311.125 and so 1311. It is
   * refused as an amount by the caller when it is out of range, as any amount is.
   */
  groupAmount(): number {
    const product = BigInt(this.value.amount) * rateScaled(this.value.rate);
    return Number((product + RATE_SCALE / 2n) / RATE_SCALE);
  }

  protected equalsValue(a: Original, b: Original): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}

const validAmount = (amount: number): boolean =>
  Number.isInteger(amount) && amount >= OriginalAmount.MIN && amount <= OriginalAmount.MAX;

/** Matches the form, and is above 0 (`0` and `0.000` are not a rate). */
const validRate = (rate: string): boolean => RATE.test(rate) && rateScaled(rate) > 0n;

/** The rate times 10^6, as an integer: `"12.5"` is 12 500 000. Only a rate that matches the form is read this way. */
const rateScaled = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(RATE_DIGITS, '0'));
};
