import { IResult, Result } from '@Architecture/Domain';

import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  InvalidRateException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The currencies Tally counts in (request 2), as Ledger keeps its own list of them. */
export const CURRENCIES: readonly string[] = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'];

/** What was paid in another currency, as the payer states it (request 21). */
export interface OriginalRequest {
  /** One of Tally's currencies, other than the group's. */
  currency: string;
  /** In the hundredths of the currency: a whole number from 1 to 100 000 000. */
  amount: number;
  /** What one unit of the currency is worth in the group's currency: a decimal string, greater than 0, at most 6 digits after the point. */
  rate: string;
}

/** How an expense's amount is given: in the group's currency, or as what was paid in another currency. */
export type ExpenseMoney = { amount: number } | { original: OriginalRequest };

/** An original amount as the snapshot keeps it: the three values, the rate as it was given. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

const RATE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept in millionths, so that the arithmetic is exact. */
const RATE_SCALE = 1_000_000n;
const HALF = 500_000n;

/**
 * What an expense was paid in, in another currency than its group's: the currency, the amount in its hundredths, and the
 * rate, kept as the string the payer gave. The amount in the group's currency is the original amount times the rate,
 * rounded to the nearest whole number, a half rounded up, computed in exact integer arithmetic and never in floating
 * point (ADR 12): 1234 at "1.0625" is 1311.125, so 1311; 1000 at "0.9545" is 954.5, so 955.
 *
 * It is validated by `create()`, which refuses by name: a currency not Tally's or the group's own, an amount out of
 * range, a rate that is not a decimal of at most 6 digits after the point, or not greater than 0. The group's amount
 * the conversion gives is checked by the expense, as any amount is.
 */
export class OriginalAmount {
  readonly #currency: string;
  readonly #amount: number;
  readonly #rate: string;
  readonly #scaledRate: bigint;

  private constructor(currency: string, amount: number, rate: string, scaledRate: bigint) {
    this.#currency = currency;
    this.#amount = amount;
    this.#rate = rate;
    this.#scaledRate = scaledRate;
  }

  /** The original amount, checked against the group's currency when it is given (a snapshot already checked it). */
  static create(request: OriginalRequest, groupCurrency?: string): IResult<OriginalAmount> {
    if (!CURRENCIES.includes(request.currency) || request.currency === groupCurrency) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (!Number.isInteger(request.amount) || request.amount < ExpenseAmount.MIN || request.amount > ExpenseAmount.MAX) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (typeof request.rate !== 'string' || !RATE.test(request.rate)) return Result.fail(new InvalidRateException());

    const [whole, fraction = ''] = request.rate.split('.');
    const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
    if (scaled === 0n) return Result.fail(new InvalidRateException());

    return Result.ok(new OriginalAmount(request.currency, request.amount, request.rate, scaled));
  }

  /** The amount in the group's currency: the original amount times the rate, a half rounded up. */
  inGroupCurrency(): number {
    return Number((BigInt(this.#amount) * this.#scaledRate + HALF) / RATE_SCALE);
  }

  get currency(): string {
    return this.#currency;
  }

  get amount(): number {
    return this.#amount;
  }

  get rate(): string {
    return this.#rate;
  }

  toSnapshot(): OriginalSnapshot {
    return { currency: this.#currency, amount: this.#amount, rate: this.#rate };
  }
}
