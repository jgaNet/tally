import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain/Currency';

import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  InvalidRate,
  NoRateOffered,
  RateOutsideBand,
  SameCurrencyAsTheGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/**
 * What an expense was paid in, as its payer gives it: a currency, an amount in its hundredths, and the rate as a string. The rate
 * may be left out (request 22): the expense then takes the rate the rates service offers for its currency on its day.
 */
export interface OriginalAmountInput {
  currency: string;
  amount: number;
  rate?: string;
}

/** An expense's money as it is given: its amount in the group's currency, or what was paid in another currency (request 21). */
export type MoneyInput = { amount: number } | { original: OriginalAmountInput };

/** Where the rate of an expense in another currency came from: the payer stated it, or it was taken from the rates service's offer. */
export type RateSource = 'stated' | 'offered';

/** A decimal number above 0 with at most 6 digits after the point, written as the payer gave it: `"0.9542"`, `"1"`, `"12.5"`. */
const RATE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept to 6 digits after the point: the exact arithmetic multiplies by 10^6. */
const RATE_DIGITS = 6;
const RATE_SCALE = 10n ** BigInt(RATE_DIGITS);
/** The band a stated rate may differ from the offered one by: 2 %, as the fraction 1/50 of the offered rate (request 22). */
const BAND_DIVISOR = 50n;

interface Original {
  currency: CurrencyCode;
  amount: number;
  rate: string;
  rateSource: RateSource;
}

/**
 * What an expense was paid in, in a currency other than its group's: the currency, the amount in that currency's hundredths
 * (1 to 100 000 000), and the rate, what one unit of that currency is worth in the group's currency. The rate is kept as the
 * string it was stated or offered as, so it is read back as it was. The amount in the group's currency is computed here, once,
 * in exact integer arithmetic: never in floating point, where a half would not be a half.
 */
export class OriginalAmount extends ValueObject<Original> {
  static readonly MIN = 1;
  static readonly MAX = 100_000_000;

  private constructor(value: Original) {
    super(value);
  }

  /**
   * Decides what was paid: a currency of Tally's other than the group's, an amount in its range, and a rate that is valid and
   * settled against the offer (`offer` is the rates service's answer for this currency on this day, read by the handler; `null`
   * when none was asked). Without a stated rate, the offered one is taken, and no offer is refused (`NoRateOffered`). With a
   * stated rate: when there is no rates service (`no-service`) it is taken as it is given; when the service offers no rate it is
   * refused (`NoRateOffered`); otherwise it is taken only within 2 % of the offer (`RateOutsideBand`).
   */
  static create(
    { currency, amount, rate }: OriginalAmountInput,
    groupCurrency: CurrencyCode,
    offer: RateOffer | null,
  ): IResult<OriginalAmount> {
    if (!isCurrencyCode(currency)) return Result.fail(new InvalidOriginalCurrency());
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsTheGroup());
    if (!validAmount(amount)) return Result.fail(new InvalidOriginalAmount());
    if (rate !== undefined && !validRate(rate)) return Result.fail(new InvalidRate());

    const settled = settleRate(rate, offer);
    if (settled.isFailure()) return settled;
    return Result.ok(
      new OriginalAmount({ currency, amount, rate: settled.data.rate, rateSource: settled.data.source }),
    );
  }

  /** Re-reads what was kept: the same rules as `create`, without the group's currency or the offer, which a kept expense does not repeat. */
  static restore({
    currency,
    amount,
    rate,
    rateSource,
  }: {
    currency: string;
    amount: number;
    rate: string;
    rateSource: RateSource;
  }): OriginalAmount | null {
    if (!isCurrencyCode(currency) || !validAmount(amount) || !validRate(rate)) return null;
    if (rateSource !== 'stated' && rateSource !== 'offered') return null;
    return new OriginalAmount({ currency, amount, rate, rateSource });
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
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate && a.rateSource === b.rateSource;
  }
}

/** The rate an expense keeps, and where it came from, settled against the offer (request 22). */
const settleRate = (
  stated: string | undefined,
  offer: RateOffer | null,
): IResult<{ rate: string; source: RateSource }> => {
  const offered = offer?.kind === 'offered' && validRate(offer.rate) ? offer.rate : null;
  if (stated === undefined) {
    return offered ? Result.ok({ rate: offered, source: 'offered' }) : Result.fail(new NoRateOffered());
  }
  if (offer?.kind === 'no-service') return Result.ok({ rate: stated, source: 'stated' });
  if (offered === null) return Result.fail(new NoRateOffered());
  if (!withinBand(stated, offered)) return Result.fail(new RateOutsideBand());
  return Result.ok({ rate: stated, source: 'stated' });
};

/** Whether a stated rate differs from the offered one by at most 2 % of the offered one, exactly: |stated − offered| × 50 ≤ offered. */
const withinBand = (stated: string, offered: string): boolean => {
  const given = rateScaled(stated);
  const reference = rateScaled(offered);
  const difference = given > reference ? given - reference : reference - given;
  return difference * BAND_DIVISOR <= reference;
};

const validAmount = (amount: number): boolean =>
  Number.isInteger(amount) && amount >= OriginalAmount.MIN && amount <= OriginalAmount.MAX;

/** Matches the form, and is above 0 (`0` and `0.000` are not a rate). */
const validRate = (rate: string): boolean => RATE.test(rate) && rateScaled(rate) > 0n;

/** Whether a text is a rate: the form above, above 0. A rates service's rate is held to the same rule (request 22). */
export const isValidRate = (text: string): boolean => validRate(text);

/** The rate times 10^6, as an integer: `"12.5"` is 12 500 000. Only a rate that matches the form is read this way. */
const rateScaled = (rate: string): bigint => {
  const [whole, fraction = ''] = rate.split('.');
  return BigInt(whole + fraction.padEnd(RATE_DIGITS, '0'));
};
