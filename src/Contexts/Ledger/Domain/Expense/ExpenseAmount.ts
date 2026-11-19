import { IResult, Result } from '@Architecture/Domain';

import {
  CURRENCIES,
  convertMinorUnits,
  CurrencyCode,
  RATE_SHAPE,
  rateInMillionths,
} from '@SharedKernel/Domain/Currency';

import { OriginalAmountSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import {
  InvalidOriginalAmountException,
  InvalidRateException,
  NoRateOfferedException,
  NonPositiveRateException,
  OriginalCurrencyIsGroupCurrencyException,
  RateOutsideBandException,
  UnknownCurrencyException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The largest amount of an expense, in whole minor units of the group's currency (docs/adr/0039). */
export const MAX_EXPENSE_AMOUNT = 100_000_000;

/**
 * The rate a rates service offers for one currency to the group's on a day (request 22, docs/adr/0021), as the Expense is given it.
 * `offered` is the rate; `none` is a service that answers no rate, or that fails to (no answer in time, another answer): an expense
 * cannot be taken on it; `unavailable` is a server with no rates service at all, where the payer's rate stands (request 21).
 */
export type OfferedRate = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'unavailable' };

/**
 * What was paid in another currency, as the payer gives it (request 21, request 22): its currency, its amount in that currency's minor
 * unit, and its rate as a string. The rate is left out when the expense takes the rate offered on its date (request 22).
 */
export interface OriginalAmountInput {
  currency: string;
  amount: number;
  rate?: string;
}

/**
 * How an expense's amount is given (request 21): either its `amount` in the group's currency, or its `original` in another currency,
 * converted at the rate the expense is recorded at to the `groupCurrency`. The transport gives exactly one of the two; the domain
 * refuses both. `offered` is the rate offered for the original's currency to the group's on the expense's date (request 22): it is
 * asked by the use case before the expense decides, and it is `none` when there is nothing to ask (an unknown currency is refused first).
 */
export interface AmountInput {
  amount?: number;
  original?: OriginalAmountInput;
  groupCurrency?: string;
  offered?: OfferedRate;
}

/** A rate may differ from the one offered by 2 % of the offered rate, at most (request 22). */
const BAND_PERCENT = 2n;

/**
 * What an expense was paid in when that was not the group's currency (request 21, the storm's hot spot 1, docs/adr/0020, docs/adr/0039).
 * It keeps the currency, the amount in that currency's minor unit and the rate the expense is recorded at, the string. The expense's
 * amount in the group's currency is the amount read in its currency's units, times the rate, written in the group's minor unit, rounded to
 * the nearest whole number, a half up: computed in integers, never in floating point (`convertMinorUnits`), so that `1000` at `"0.9545"`
 * is `955` in cents, and 10 000 yen at `"0.0062"` is `6200` in cents.
 *
 * `create()` decides the rate (request 22, docs/adr/0021) against the offer, and refuses a currency that is not one of Tally's, the
 * group's own, an amount that is not 1 to 100 000 000, and a rate that is not one the offer allows (`recordedRate`). `read()` checks
 * what the store kept, which was checked when it was given.
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

  static create(input: OriginalAmountInput, groupCurrency: string, offered: OfferedRate): IResult<OriginalAmount> {
    if (!CURRENCIES.includes(input.currency as CurrencyCode)) return Result.fail(new UnknownCurrencyException());
    if (input.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    const rate = recordedRate(input.rate, offered);
    if (rate.isFailure()) return rate;
    return Result.ok(new OriginalAmount(input.currency as CurrencyCode, input.amount, rate.data));
  }

  /** Reads what the store kept: the currency, the amount and the rate it was recorded at, each checked as `create()` checks it. */
  static read(input: OriginalAmountSnapshot): IResult<OriginalAmount> {
    if (!CURRENCIES.includes(input.currency as CurrencyCode)) return Result.fail(new UnknownCurrencyException());
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_EXPENSE_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (!RATE_SHAPE.test(input.rate)) return Result.fail(new InvalidRateException());
    if (rateInMillionths(input.rate) === 0n) return Result.fail(new NonPositiveRateException());
    return Result.ok(new OriginalAmount(input.currency as CurrencyCode, input.amount, input.rate));
  }

  /** The amount in the group's currency's minor unit: the amount converted at the rate, rounded to the nearest whole number, a half up. */
  toGroupAmount(groupCurrency: CurrencyCode): number {
    return convertMinorUnits(this.amount, this.currency, this.rate, groupCurrency);
  }

  toSnapshot(): OriginalAmountSnapshot {
    return { currency: this.currency, amount: this.amount, rate: this.rate };
  }
}

/**
 * The rate an expense in another currency is recorded at (request 22, docs/adr/0021). Left out, it is the rate offered. Given, it is
 * the payer's, and the offer decides whether it stands:
 *
 * - no rates service (`unavailable`): the payer's rate stands, whatever it is (request 21);
 * - a service with no rate (`none`): refused, as there is no rate to compare it with, `NoRateOffered`;
 * - a rate offered: refused by name when it differs from the offered rate by more than 2 % of the offered rate, `RateOutsideBand`.
 *
 * A rate that is not a decimal of at most 6 digits, or is 0, is refused whatever the offer. Left out with no rate offered, it is
 * refused too (`NoRateOffered`): an expense is never recorded at no rate.
 */
export function recordedRate(stated: string | undefined, offered: OfferedRate): IResult<string> {
  if (stated === undefined) {
    return offered.kind === 'offered' ? Result.ok(offered.rate) : Result.fail(new NoRateOfferedException());
  }
  if (!RATE_SHAPE.test(stated)) return Result.fail(new InvalidRateException());
  if (rateInMillionths(stated) === 0n) return Result.fail(new NonPositiveRateException());
  if (offered.kind === 'unavailable') return Result.ok(stated);
  if (offered.kind === 'none') return Result.fail(new NoRateOfferedException());
  if (!withinBand(stated, offered.rate)) return Result.fail(new RateOutsideBandException());
  return Result.ok(stated);
}

/**
 * Whether a rate a service offers is one the Expense can take: a decimal of at most 6 digits after the point, written as a string,
 * greater than 0 (request 22). The adapter checks what it reads with it; anything else is no rate offered.
 */
export function isOfferableRate(rate: unknown): rate is string {
  return typeof rate === 'string' && RATE_SHAPE.test(rate) && rateInMillionths(rate) > 0n;
}

/** Whether `stated` differs from `offered` by no more than 2 % of `offered`, both in millionths, exactly. */
function withinBand(stated: string, offered: string): boolean {
  const a = rateInMillionths(stated);
  const b = rateInMillionths(offered);
  const difference = a > b ? a - b : b - a;
  return difference * 100n <= b * BAND_PERCENT;
}
