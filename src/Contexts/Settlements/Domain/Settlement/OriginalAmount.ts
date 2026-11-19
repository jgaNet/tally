import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain/Currency';

import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  NoRateOffered,
  SameCurrencyAsTheGroup,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** What a payment is paid in, as the payer gives it: a currency of Tally's and an amount in its hundredths (request 39). */
export interface OriginalPayment {
  currency: string;
  amount: number;
}

/**
 * What a settlement is paid in, as it is decided: the group's amount (`{ amount }`), or what was paid in another currency (`{ original }`),
 * with the group's currency and the rate the rates service offered on the day it is decided (`null` when it offered none). The rate is an
 * input the book takes, so that a decision is a function of what it is given (DOMAIN-NON-DETERMINISM).
 */
export type PaidIn = { amount: number } | { original: OriginalPayment; groupCurrency: string; rate: string | null };

/** The rate as Tally keeps it: a decimal number in a string, above 0, at most 6 digits after the point (request 22). */
const RATE = /^\d+(\.\d{1,6})?$/;
const RATE_DIGITS = 6;
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS);

interface Original {
  currency: CurrencyCode;
  amount: number;
  rate: string;
}

/**
 * What a settlement was paid in, in a currency other than its group's: the currency, the amount in that currency's hundredths (1 to
 * 100 000 000), and the rate it was decided at, what one unit of that currency is worth in the group's currency. The rate is kept as the
 * string the rates service wrote it, and the group's amount is computed here once, in exact integer arithmetic, the same way as an
 * expense's (request 21): a half rounded up, never a floating-point half.
 */
export class OriginalAmount extends ValueObject<Original> {
  static readonly MIN = 1;
  static readonly MAX = 100_000_000;

  private constructor(value: Original) {
    super(value);
  }

  /**
   * Decides what was paid: a currency of Tally's other than the group's, an amount in its range, and the rate offered (`null` when
   * none). A rate that is not offered, or not valid, is refused (`NoRateOffered`): the payer does not give a rate.
   */
  static create(
    { currency, amount }: OriginalPayment,
    groupCurrency: string,
    rate: string | null,
  ): IResult<OriginalAmount> {
    if (!isCurrencyCode(currency)) return Result.fail(new InvalidOriginalCurrency());
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsTheGroup());
    if (!validAmount(amount)) return Result.fail(new InvalidOriginalAmount());
    if (rate === null || !validRate(rate)) return Result.fail(new NoRateOffered());
    return Result.ok(new OriginalAmount({ currency, amount, rate }));
  }

  /** Re-reads what was kept, as it was decided: the same checks as `create`, without the group's currency or the offer. */
  static restore({
    currency,
    amount,
    rate,
  }: {
    currency: string;
    amount: number;
    rate: string;
  }): OriginalAmount | null {
    if (!isCurrencyCode(currency) || !validAmount(amount) || !validRate(rate)) return null;
    return new OriginalAmount({ currency, amount, rate });
  }

  get currency(): CurrencyCode {
    return this.value.currency;
  }

  /** The amount in the original currency's hundredths. */
  get amount(): number {
    return this.value.amount;
  }

  /** The rate as the rates service wrote it. */
  get rate(): string {
    return this.value.rate;
  }

  /**
   * A whole amount in the original currency, in the group's currency at this rate: the amount times the rate, to the nearest whole
   * number, a half up. It is used for the payment's amount and for the provider's fee, which is in the payment's currency.
   */
  inGroupCurrency(hundredths: number): number {
    const product = BigInt(hundredths) * rateScaled(this.value.rate);
    return Number((product + RATE_SCALE / 2n) / RATE_SCALE);
  }

  protected equalsValue(a: Original, b: Original): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}

const validAmount = (amount: number): boolean =>
  Number.isInteger(amount) && amount >= OriginalAmount.MIN && amount <= OriginalAmount.MAX;

/** Matches the form, and is above 0. */
const validRate = (rate: string): boolean => RATE.test(rate) && rateScaled(rate) > 0n;

/** The rate times 10^6, as an integer: `"12.5"` is 12 500 000. Only a rate that matches the form is read this way. */
const rateScaled = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(RATE_DIGITS, '0'));
};
