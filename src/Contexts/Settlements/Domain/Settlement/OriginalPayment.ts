import { IResult, Result } from '@Architecture/Domain';

import {
  convertMinorUnits,
  CURRENCIES,
  CurrencyCode,
  RATE_SHAPE,
  rateInMillionths,
} from '@SharedKernel/Domain/Currency';

import {
  InvalidOriginalAmountException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
  UnknownOriginalCurrencyException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** The largest amount paid in another currency, in the minor units of that currency (request 39, docs/adr/0039). */
export const MAX_ORIGINAL_AMOUNT = 100_000_000;

/**
 * The rate the rates service offers for one currency to the group's on a day (request 22, request 39), as the book is given it: `offered`
 * with the rate, or `none` when the service has no rate, does not answer one in time, or is not configured. A settlement in another
 * currency takes the rate offered; without one it is refused, and nothing is kept.
 */
export type OfferedRate = { kind: 'offered'; rate: string } | { kind: 'none' };

/** What a settlement is paid in, as a member asks for it (request 39): its currency and its amount in that currency's minor unit. */
export interface OriginalPaymentInput {
  currency: string;
  amount: number;
}

/** What a settlement in another currency keeps (request 39): its currency, its amount in that currency's minor unit, and the rate it was decided at. */
export interface OriginalPaymentSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * What a settlement is paid in when that is not the group's currency (request 39, docs/adr/0038). It keeps the currency, the amount in that
 * currency's minor unit and the rate it was decided at, as the string the rates service wrote. An amount in the group's currency is the
 * amount read in its currency's units, times the rate, in the group's minor unit, rounded to the nearest whole number, a half up, in
 * integers: the same conversion as an expense in another currency (request 21, docs/adr/0039). The same value converts a provider's fee in
 * the payment's currency (request 38).
 *
 * `decide()` takes the rate as an input of the decision (DOMAIN-NON-DETERMINISM): the book asks for it before it decides, and refuses what
 * is not a currency of Tally, the group's own, an amount that is not 1 to 100 000 000, and a missing rate.
 */
export class OriginalPayment {
  readonly currency: CurrencyCode;
  readonly amount: number;
  readonly rate: string;

  private constructor(currency: CurrencyCode, amount: number, rate: string) {
    this.currency = currency;
    this.amount = amount;
    this.rate = rate;
  }

  static decide(input: OriginalPaymentInput, groupCurrency: string, offered: OfferedRate): IResult<OriginalPayment> {
    if (!CURRENCIES.includes(input.currency as CurrencyCode))
      return Result.fail(new UnknownOriginalCurrencyException());
    if (input.currency === groupCurrency) return Result.fail(new OriginalCurrencyIsGroupCurrencyException());
    if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_ORIGINAL_AMOUNT) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    // A rate the service offers that is not one it can be used with is no rate: the settlement is refused, as for no answer.
    if (offered.kind !== 'offered' || !RATE_SHAPE.test(offered.rate) || rateInMillionths(offered.rate) === 0n) {
      return Result.fail(new NoRateOfferedException());
    }
    return Result.ok(new OriginalPayment(input.currency as CurrencyCode, input.amount, offered.rate));
  }

  /**
   * The amount in the group's currency for `units` of this one, in its minor unit: the units times the rate, a half up, in the group's
   * minor unit (docs/adr/0039).
   */
  groupAmountOf(units: number, groupCurrency: string): number {
    return convertMinorUnits(units, this.currency, this.rate, groupCurrency as CurrencyCode);
  }

  toSnapshot(): OriginalPaymentSnapshot {
    return { currency: this.currency, amount: this.amount, rate: this.rate };
  }
}
