import { IResult, Result } from '@Architecture/Domain';

import { OriginalSnapshot } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  NoRateOfferedException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/RateOffer';

/** The currencies Tally counts in (request 2), as Settlements keeps its own list of them. */
export const CURRENCIES: readonly string[] = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'];

/** What is paid in another currency, as the payer gives it (request 39): one of Tally's, other than the group's, and its amount in hundredths. */
export interface OriginalRequest {
  currency: string;
  amount: number;
}

/** The smallest and the largest amount in another currency, in the hundredths of it (request 39). */
const MIN_ORIGINAL = 1;
const MAX_ORIGINAL = 100_000_000;

const RATE = /^\d+(\.\d{1,6})?$/;
/** A rate is kept in millionths, so that the arithmetic is exact. */
const RATE_SCALE = 1_000_000n;
const HALF = 500_000n;

/**
 * What a settlement is paid in, in another currency than its group's (request 39): the currency, the amount in its hundredths,
 * and the rate, kept as the decimal string the rates service offered. The amount in the group's currency is the original amount
 * times the rate, rounded to the nearest whole number, a half rounded up, in exact integer arithmetic and never in floating point
 * (as an expense in another currency is, ADR 12): 1234 at "1.0625" is 1311.125, so 1311; 1000 at "0.9545" is 954.5, so 955.
 *
 * The rate is the one offered for the currency and the day the settlement is decided: `create()` refuses it by name when no rate
 * is offered (`NoRateOffered`), and the book decides it with the rate in hand; the rate is then kept with the settlement, so a
 * payment that lands later counts what was decided. The same rate converts the provider's fee, which the provider gives in this
 * currency (request 38). Refusals are named: `InvalidOriginalCurrency`, `InvalidOriginalAmount`, `NoRateOffered`.
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

  /** Decides what is paid in another currency, at the rate offered. Refused as a failed Result, never thrown. */
  static create(request: OriginalRequest, groupCurrency: string, offer: RateOffer): IResult<OriginalAmount> {
    if (!CURRENCIES.includes(request.currency) || request.currency === groupCurrency) {
      return Result.fail(new InvalidOriginalCurrencyException());
    }
    if (!Number.isInteger(request.amount) || request.amount < MIN_ORIGINAL || request.amount > MAX_ORIGINAL) {
      return Result.fail(new InvalidOriginalAmountException());
    }
    const scaled = offer.kind === 'offered' ? rateMillionths(offer.rate) : null;
    if (offer.kind !== 'offered' || scaled === null) return Result.fail(new NoRateOfferedException());

    return Result.ok(new OriginalAmount(request.currency, request.amount, offer.rate, scaled));
  }

  /** The original amount, in the group's currency: the original amount times the rate, a half rounded up. */
  groupAmount(): number {
    return this.convert(this.#amount);
  }

  /** Any amount in this currency, in its hundredths, converted at this rate into the group's currency, a half rounded up (the fee). */
  convert(hundredths: number): number {
    return Number((BigInt(hundredths) * this.#scaledRate + HALF) / RATE_SCALE);
  }

  get currency(): string {
    return this.#currency;
  }

  get amount(): number {
    return this.#amount;
  }

  toSnapshot(): OriginalSnapshot {
    return { currency: this.#currency, amount: this.#amount, rate: this.#rate };
  }
}

/** A rate as the count of its millionths, or null when it is not a decimal of at most 6 digits after the point, or not greater than 0. */
export function rateMillionths(rate: string): bigint | null {
  if (!RATE.test(rate)) return null;

  const [whole, fraction = ''] = rate.split('.');
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
  return scaled === 0n ? null : scaled;
}
