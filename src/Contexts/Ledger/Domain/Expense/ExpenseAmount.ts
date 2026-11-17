import { IResult, Result } from '@Architecture/Domain';

import { CURRENCIES, CurrencyCode } from '@SharedKernel/Domain/Currency';

import { OriginalAmountSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  InvalidOriginalAmountException,
  InvalidRateException,
  NonPositiveRateException,
  OriginalCurrencyIsGroupCurrencyException,
  UnknownCurrencyException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The largest amount of an expense, in whole units of the group's currency. */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

/** What was paid in another currency, as the payer gives it (request 21): its currency, its amount in hundredths, its rate. */
export interface OriginalAmountInput {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * How an expense's amount is given (request 21): either its `amount` in the group's currency, or its `original` in another currency,
 * converted at the rate the payer states to the `groupCurrency`. The transport gives exactly one of the two; the domain refuses both.
 */
export interface AmountInput {
  amount?: number;
  original?: OriginalAmountInput;
  groupCurrency?: string;
}

/** A rate, as the payer states it: a decimal number, written as a string, with at most 6 digits after the point. */
const RATE_SHAPE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept as an integer of millionths, so that its product with an amount is exact. */
const MILLIONTHS = 1_000_000n;

/**
 * What an expense was paid in when that was not the group's currency (request 21, the storm's hot spot 1, docs/adr/0020). It keeps
 * the currency, the amount in that currency's hundredths and the rate as the payer gave it, the string. The expense's amount in the
 * group's currency is the amount times the rate, rounded to the nearest whole number, a half up: computed in integers, never in
 * floating point, so that `1000` at `"0.9545"` is `954.5`, which is `955`.
 *
 * `create()` refuses a currency that is not one of Tally's, the group's own, an amount that is not 1 to 100 000 000, and a rate that
 * is not a decimal of at most 6 digits after the point, or is not greater than 0. Without the group's currency (`create(input)`) it
 * checks the rest: that is how the store's kept value is read back, which was checked when it was given.
 */
export class OriginalAmount {
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly rate: string;

  private constructor(currency: CurrencyCode, amount: number, rate: string) {
    this.currency = currency;
    this.amount = amount;
    this.rate = rate;
  }

  static create(input: OriginalAmountInput, groupCurrency?: string): IResult<OriginalAmount> {
    if (!CURRENCIES.includes(input.currency as CurrencyCode)) return Result.fail(new UnknownCurrencyException());
    if (groupCurrency !== undefined && input.currency === groupCurrency) {
      return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    }
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (!RATE_SHAPE.test(input.rate)) return Result.fail(new InvalidRateException());
    if (rateInMillionths(input.rate) === 0n) return Result.fail(new NonPositiveRateException());
    return Result.ok(new OriginalAmount(input.currency as CurrencyCode, input.amount, input.rate));
  }

  /** The amount in the group's currency: the amount times the rate, rounded to the nearest whole number, a half rounded up. */
  toGroupAmount(): number {
    const scaled = BigInt(this.amount) * rateInMillionths(this.rate);
    return Number((scaled + MILLIONTHS / 2n) / MILLIONTHS);
  }

  toSnapshot(): OriginalAmountSnapshot {
    return { currency: this.currency, amount: this.amount, rate: this.rate };
  }
}

/** The rate in millionths: `"12.5"` is 12 500 000. The rate is checked to be a decimal of at most 6 digits before this is read. */
function rateInMillionths(rate: string): bigint {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(6, '0'));
}
