import { IResult, Result } from '@Architecture/Domain';
import { CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain';

import { ExpenseAmount } from './ExpenseAmount';
import {
  InvalidExpenseRateException,
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  OriginalCurrencyIsGroupCurrencyException,
} from './ExpenseExceptions';

/** What an expense paid in another currency is kept as: its currency, its amount in that currency's hundredths, and its rate as given. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

/** A rate: a decimal number written as a string, with at most 6 digits after the point (request 21). */
const RATE_FORMAT = /^\d+(\.\d{1,6})?$/;
/** The rate is held in millionths, so a rate of six digits after the point is a whole number of them. */
const RATE_SCALE = 1_000_000n;

/**
 * An expense paid in another currency, as its payer states it (request 21): what was paid, in one of Tally's currencies other
 * than the group's, in its hundredths from 1 to 100 000 000, and the rate at which one of that currency is worth the group's
 * currency, kept as the decimal string it was given. Its amount in the group's currency is the original amount times the rate,
 * rounded to the nearest whole number, a half rounded up, computed in exact integer arithmetic and never in floating point:
 * the expense splits and counts that amount, and this value keeps both amounts and the rate, as they were given.
 */
export class OriginalAmount {
  static readonly MAX = 100_000_000;

  private constructor(
    readonly currency: CurrencyCode,
    readonly amount: number,
    readonly rate: string,
  ) {}

  /**
   * The original amount, as given, in a group of `groupCurrency`: the currency is one of Tally's and not the group's, the amount is
   * a whole number from 1 to 100 000 000, and the rate is a decimal number greater than 0 with at most 6 digits after the point.
   * Refusals are named by their exception.
   */
  static create(raw: OriginalSnapshot, groupCurrency: string): IResult<OriginalAmount> {
    if (isCurrencyCode(raw.currency) && raw.currency === groupCurrency) {
      return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    }
    return OriginalAmount.of(raw);
  }

  /**
   * The original amount, validated as `create` validates it, but not against the group's currency: what a stored expense is
   * rebuilt from, which was checked when it was recorded or edited.
   */
  static of(raw: OriginalSnapshot): IResult<OriginalAmount> {
    if (!isCurrencyCode(raw.currency)) return Result.fail(new InvalidOriginalCurrencyException());
    if (!Number.isInteger(raw.amount) || raw.amount < 1 || raw.amount > OriginalAmount.MAX) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (typeof raw.rate !== 'string' || !RATE_FORMAT.test(raw.rate) || rateInMillionths(raw.rate) === 0n) {
      return Result.fail(new InvalidExpenseRateException());
    }
    return Result.ok(new OriginalAmount(raw.currency, raw.amount, raw.rate));
  }

  /**
   * The amount in the group's currency: this amount times the rate, rounded to the nearest whole number, a half rounded up. Its
   * result is checked by `ExpenseAmount` like any amount: 0 or more than 100 000 000 is refused there, by name.
   */
  groupAmount(): number {
    const product = BigInt(this.amount) * rateInMillionths(this.rate);
    // round(product / 10^6) with a half rounded up, in integers: floor((2 * product + 10^6) / (2 * 10^6)).
    return Number((2n * product + RATE_SCALE) / (2n * RATE_SCALE));
  }

  /** The expense's amount in the group's currency, validated as any expense amount is. */
  groupExpenseAmount(): IResult<ExpenseAmount> {
    return ExpenseAmount.create(this.groupAmount());
  }

  toSnapshot(): OriginalSnapshot {
    return { currency: this.currency, amount: this.amount, rate: this.rate };
  }
}

/** The rate, as a whole number of millionths: "12.5" is 12 500 000. Only called on a rate `RATE_FORMAT` accepts. */
const rateInMillionths = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
};
