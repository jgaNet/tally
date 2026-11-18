import { IResult, Result } from '@Architecture/Domain';
import { decimalsOf, isCurrency } from '@SharedKernel/Domain/Currency';

import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  InvalidRateException,
  NoRateOfferedException,
  RateOutsideBandException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { RateOffer } from '@Contexts/Ledger/Domain/Expense/RateOffer';

/** What was paid in another currency, as the payer states it (request 21, and request 22 when the rate is left out). */
export interface OriginalRequest {
  /** One of Tally's currencies, other than the group's. */
  currency: string;
  /** In the minor unit of the currency (hundredths, yen, thousandths): a whole number from 1 to 100 000 000. */
  amount: number;
  /**
   * What one unit of the currency is worth in the group's currency: a decimal string, greater than 0, at most 6 digits after
   * the point. Left out, the rate offered for the currency and the day is taken (request 22).
   */
  rate?: string;
}

/** How an expense's amount is given: in the group's currency, or as what was paid in another currency. */
export type ExpenseMoney = { amount: number } | { original: OriginalRequest };

/** An original amount as the snapshot keeps it: the three values, the rate as it was given or taken. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

const RATE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept in millionths, so that the arithmetic is exact. */
const RATE_SCALE = 1_000_000n;
/** A stated rate may differ from the offered one by at most 2 % of the offered one, both ends included (request 22). */
const BAND_PERCENT = 2n;
/** A stored original amount was decided when it was recorded: its rate is taken as it is. */
const AS_STORED: RateOffer = { kind: 'unconfigured' };

/**
 * A rate as the count of its millionths, or null when it is not a decimal of at most 6 digits after the point, or not greater
 * than 0. The rate a service offers is read by the same rule (request 22), so that a stated and an offered rate compare exactly.
 */
export function rateMillionths(rate: unknown): bigint | null {
  if (typeof rate !== 'string' || !RATE.test(rate)) return null;

  const [whole, fraction = ''] = rate.split('.');
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
  return scaled === 0n ? null : scaled;
}

/**
 * What an expense was paid in, in another currency than its group's: the currency, the amount in its minor unit, and the
 * rate, kept as the decimal string it was given or taken as. The amount in the group's currency is the original amount, read in
 * its currency's units, times the rate, written in the group's minor unit, rounded to the nearest whole number, a half rounded up,
 * computed in exact integer arithmetic and never in floating point (ADR 12, ADR 25): 1234 at "1.0625" is 1311.125, so 1311;
 * 1000 at "0.9545" is 954.5, so 955; in a yen group, 1250 euro cents at "161.5" is 2018.75 yen, so 2019.
 *
 * The rate is settled by `create()` against the rate offered for the currency and the day (ADR 13), which the Expense is given
 * as an input like any other: a rate left out is the offered one; a stated rate is taken when no rates service is configured,
 * and otherwise must be within 2 % of the offered rate. Refusals are named: `InvalidOriginalCurrency`, `InvalidOriginalAmount`,
 * `InvalidRate`, `NoRateOffered`, `RateOutsideBand`. The group's amount it gives is checked by the expense, as any amount is.
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

  /**
   * Decides what was paid in another currency. `groupCurrency` is the currency the group counts in, when known; `offer` is the
   * rate offered for the currency and the day, or null when none was asked. Refused as a failed Result, never thrown.
   */
  static create(
    request: OriginalRequest,
    groupCurrency: string | undefined,
    offer: RateOffer | null,
  ): IResult<OriginalAmount> {
    if (!isCurrency(request.currency) || request.currency === groupCurrency) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (!Number.isInteger(request.amount) || request.amount < ExpenseAmount.MIN || request.amount > ExpenseAmount.MAX) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    if (request.rate !== undefined && rateMillionths(request.rate) === null) {
      return Result.fail(new InvalidRateException());
    }

    const settled = settleRate(request.rate, offer);
    if (settled.isFailure()) return Result.fail(settled.error);
    const scaled = rateMillionths(settled.data);
    if (scaled === null) return Result.fail(new InvalidRateException());

    return Result.ok(new OriginalAmount(request.currency, request.amount, settled.data, scaled));
  }

  /** Rebuilds an original amount from what was stored: its rate was settled when it was recorded, and is taken as it is. */
  static restore(snapshot: OriginalSnapshot): IResult<OriginalAmount> {
    return OriginalAmount.create(snapshot, undefined, AS_STORED);
  }

  /**
   * The amount in the group's currency, in its minor unit: the original amount, read in its currency's units, times the rate, a
   * half rounded up. Between two currencies that count in hundredths it is the original amount times the rate, as it always was.
   */
  inGroupCurrency(groupCurrency: string): number {
    return convertMinorUnits({
      amount: this.#amount,
      from: this.#currency,
      to: groupCurrency,
      scaledRate: this.#scaledRate,
    });
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

/**
 * An amount in the minor unit of one currency, converted into the minor unit of another at a rate kept in millionths of a unit of
 * the second per unit of the first: `amount × rate × 10^toDecimals / 10^(fromDecimals + 6)`, a half rounded up, in exact integers.
 * The rate scale (6) is an even power, so the half is a whole number of the denominator.
 */
export function convertMinorUnits({
  amount,
  from,
  to,
  scaledRate,
}: {
  amount: number;
  from: string;
  to: string;
  scaledRate: bigint;
}): number {
  const numerator = BigInt(amount) * scaledRate * 10n ** BigInt(decimalsOf(to));
  const denominator = 10n ** BigInt(decimalsOf(from) + 6);
  return Number((numerator + denominator / 2n) / denominator);
}

/**
 * The rate an expense takes (requests 21 and 22). Left out, it is the offered rate, and no offer is a refusal. Stated, it is
 * taken as it is when no rates service is configured; with no offer it is refused; with an offer it is taken when it differs
 * from the offered rate by at most 2 % of the offered one, and refused by name otherwise.
 */
function settleRate(stated: string | undefined, offer: RateOffer | null): IResult<string> {
  if (stated === undefined) {
    return offer?.kind === 'offered' ? Result.ok(offer.rate) : Result.fail(new NoRateOfferedException());
  }
  if (offer?.kind === 'unconfigured') return Result.ok(stated);
  if (offer?.kind !== 'offered') return Result.fail(new NoRateOfferedException());

  const offered = rateMillionths(offer.rate);
  const given = rateMillionths(stated);
  if (offered === null || given === null) return Result.fail(new NoRateOfferedException());

  const difference = given > offered ? given - offered : offered - given;
  // |given - offered| <= 2 % of offered, in integers: 100 × difference <= BAND_PERCENT × offered (2 = 2 %).
  const withinBand = 100n * difference <= BAND_PERCENT * offered;
  return withinBand ? Result.ok(stated) : Result.fail(new RateOutsideBandException());
}
