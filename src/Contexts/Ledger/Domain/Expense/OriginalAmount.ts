import { IResult, Result } from '@Architecture/Domain';
import { convertAtRate, CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain';

import { ExpenseAmount } from './ExpenseAmount';
import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  OriginalCurrencyIsGroupCurrencyException,
  InvalidExpenseRateException,
} from './ExpenseExceptions';
import { NoRateOfferedException, RateOutsideBandException } from './RateExceptions';
import { isRate, RateOffer, withinBand } from './Rate';

/** What an expense paid in another currency is kept as: its currency, its amount in that currency's hundredths, and its rate as given. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * What a recording or an edit gives for an expense paid in another currency (request 21, request 22): the currency, the amount, and the
 * rate its payer states, or none, in which case the rate offered for the currency and the day is taken.
 */
export interface OriginalGiven {
  currency: string;
  amount: number;
  rate?: string;
}

/** Only an offered rate is taken when no rate is given; when one is, it is checked against the offer (request 22). */
const rateOf = (given: string | undefined, offered: RateOffer): IResult<string> => {
  if (given === undefined) {
    return offered.kind === 'rate' ? Result.ok(offered.rate) : Result.fail(new NoRateOfferedException());
  }
  if (!isRate(given)) return Result.fail(new InvalidExpenseRateException());
  switch (offered.kind) {
    case 'no-service':
      return Result.ok(given);
    case 'none':
      return Result.fail(new NoRateOfferedException());
    case 'rate':
      return withinBand(given, offered.rate) ? Result.ok(given) : Result.fail(new RateOutsideBandException());
  }
};

/**
 * An expense paid in another currency, as its payer states it (request 21, request 22): what was paid, in one of Tally's currencies other
 * than the group's, in its currency's minor unit from 1 to 100 000 000, and the rate at which one of that currency is worth the group's currency,
 * kept as the decimal string it was given or, when none was given, as the one offered (request 22). Its amount in the group's currency
 * is the original amount times the rate, rounded to the nearest whole number, a half rounded up, computed in exact integer arithmetic and
 * never in floating point, from the minor unit of its currency into the group's (ADR 38): the expense splits and counts that amount, and this
 * value keeps both amounts and the rate.
 */
export class OriginalAmount {
  static readonly MAX = 100_000_000;

  private constructor(
    readonly currency: CurrencyCode,
    readonly amount: number,
    readonly rate: string,
  ) {}

  /**
   * The original amount, as given, in a group of `groupCurrency`: the currency is one of Tally's and not the group's, the amount is a
   * whole number from 1 to 100 000 000, and the rate is the one given (a decimal number greater than 0 with at most 6 digits after the
   * point), or the one offered when none is given. A rate given is checked against the offer: within 2 % of it, or taken as it is when no
   * rates service is configured (`no-service`); refused by name when no rate is offered at all. Refusals are named by their exception.
   */
  static create(raw: OriginalGiven, groupCurrency: string, offered: RateOffer): IResult<OriginalAmount> {
    if (isCurrencyCode(raw.currency) && raw.currency === groupCurrency) {
      return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    }
    if (!isCurrencyCode(raw.currency)) return Result.fail(new InvalidOriginalCurrencyException());
    if (!isAmount(raw.amount)) return Result.fail(new InvalidOriginalAmountException());
    const rate = rateOf(raw.rate, offered);
    if (rate.isFailure()) return rate;
    return Result.ok(new OriginalAmount(raw.currency, raw.amount, rate.data));
  }

  /**
   * The original amount, validated as `create` validates it, but not against the group's currency nor the offer: what a stored expense is
   * rebuilt from, which was checked when it was recorded or edited.
   */
  static of(raw: OriginalSnapshot): IResult<OriginalAmount> {
    if (!isCurrencyCode(raw.currency)) return Result.fail(new InvalidOriginalCurrencyException());
    if (!isAmount(raw.amount)) return Result.fail(new InvalidOriginalAmountException());
    if (!isRate(raw.rate)) return Result.fail(new InvalidExpenseRateException());
    return Result.ok(new OriginalAmount(raw.currency, raw.amount, raw.rate));
  }

  /**
   * The amount in the group's currency's minor unit: this amount, in its own currency's minor unit, times the rate, rounded to the nearest
   * whole number, a half rounded up (ADR 38). Its result is checked by `ExpenseAmount` like any amount: 0 or more than 100 000 000 is refused
   * there, by name.
   */
  groupAmount(groupCurrency: string): number {
    return convertAtRate(this.amount, this.rate, this.currency, groupCurrency);
  }

  /** The expense's amount in the group's currency, validated as any expense amount is. */
  groupExpenseAmount(groupCurrency: string): IResult<ExpenseAmount> {
    return ExpenseAmount.create(this.groupAmount(groupCurrency));
  }

  toSnapshot(): OriginalSnapshot {
    return { currency: this.currency, amount: this.amount, rate: this.rate };
  }
}

const isAmount = (raw: number): boolean => Number.isInteger(raw) && raw >= 1 && raw <= OriginalAmount.MAX;
