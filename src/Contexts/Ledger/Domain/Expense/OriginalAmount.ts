import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { RateOffer, RateSource } from '@Contexts/Ledger/Domain/Expense/RateOffer';
import {
  InvalidAmount,
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  InvalidRate,
  NoRateOffered,
  RateOutsideBand,
  SameCurrencyAsGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense was paid in, when it was not paid in the group's currency: its currency, its amount in hundredths, and the rate. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  /** The rate as the payer gave it, or as the offer gave it: kept as the string it was written as, read back the same. */
  rate: string;
}

/**
 * What an expense was paid in another currency than its group's (request 21): the currency, the amount in its hundredths,
 * and the rate, what one of that currency is worth in the group's currency. The amount in the group's currency is the
 * original amount times the rate, rounded to the nearest whole number, a half rounded up, in exact decimal arithmetic:
 * the rate is read as a whole number of millionths, never a floating point number.
 *
 * The rate is taken by `takeRate()` (request 22, ADR 15): left out, it is the rate offered for the day; given, it is kept
 * when no rates service is configured, and otherwise refused by name unless it is within 2 % of the offer.
 */
export class OriginalAmount extends ValueObject<OriginalSnapshot> {
  /** Tally's currencies, as Groups has them (request 2): the group's own is not one an expense is paid in other than. */
  static readonly CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

  /** A rate is a decimal number of at most six digits after the point, written as a string. */
  private static readonly RATE = /^\d+(\.\d{1,6})?$/;

  private constructor(value: OriginalSnapshot) {
    super(value);
  }

  /**
   * Whether an expense may be paid in `currency` when the group is in `groupCurrency`: one of Tally's, and not the group's.
   */
  static checkCurrency(currency: string, groupCurrency: string): IResult {
    if (!(OriginalAmount.CURRENCIES as readonly string[]).includes(currency)) {
      return Result.fail(new InvalidOriginalCurrency(OriginalAmount.CURRENCIES));
    }
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsGroup());
    return Result.ok();
  }

  /**
   * The rate an expense is recorded at (request 22, ADR 15), from the rate the payer states, if any, and the rate offered
   * for the day. Left out, the offer is taken, and a refusal when there is none (NoRateOffered). Given, the rate must be a
   * decimal number greater than 0 (InvalidRate); with no rates service (`unconfigured`) it is taken as the payer's, as
   * request 21 takes it; with a service that offers no rate (`none`) it is refused (NoRateOffered), and with an offer it is
   * refused unless it differs from the offer by no more than 2 % of the offer (RateOutsideBand). Exact decimal arithmetic.
   */
  static takeRate({ rate, offer }: { rate?: string; offer: RateOffer }): IResult<{ rate: string; source: RateSource }> {
    if (rate === undefined) {
      if (offer.kind !== 'offered') return Result.fail(new NoRateOffered());
      return Result.ok({ rate: offer.rate, source: 'offered' });
    }
    if (!OriginalAmount.RATE.test(rate) || OriginalAmount.scaledRate(rate) === 0n) {
      return Result.fail(new InvalidRate());
    }
    if (offer.kind === 'unconfigured') return Result.ok({ rate, source: 'unchecked' });
    if (offer.kind === 'none') return Result.fail(new NoRateOffered());
    // Within 2 % of the offer: |given - offered| <= offered / 50, in millionths, with no rounding.
    const given = OriginalAmount.scaledRate(rate);
    const offered = OriginalAmount.scaledRate(offer.rate);
    const difference = given > offered ? given - offered : offered - given;
    if (difference * 50n > offered) return Result.fail(new RateOutsideBand(offer.rate));
    return Result.ok({ rate, source: 'checked' });
  }

  /**
   * An amount paid in `currency`, when the group is in `groupCurrency`. The currency must be one of Tally's and not the
   * group's; the amount a whole number of hundredths from 1 to 100 000 000; the rate a decimal number greater than 0 with
   * at most six digits after the point. The rate is the one `takeRate()` decided.
   */
  static create({
    currency,
    amount,
    rate,
    groupCurrency,
  }: {
    currency: string;
    amount: number;
    rate: string;
    groupCurrency: string;
  }): IResult<OriginalAmount> {
    const inCurrency = OriginalAmount.checkCurrency(currency, groupCurrency);
    if (inCurrency.isFailure()) return inCurrency;
    if (!Number.isInteger(amount) || amount < 1 || amount > Amount.MAX) {
      return Result.fail(new InvalidOriginalAmount(Amount.MAX));
    }
    if (!OriginalAmount.RATE.test(rate) || OriginalAmount.scaledRate(rate) === 0n) {
      return Result.fail(new InvalidRate());
    }
    return Result.ok(new OriginalAmount({ currency, amount, rate }));
  }

  /** An expense as it was stored: its values were checked when it was given, and corrupted data is refused by throwing. */
  static fromSnapshot(snapshot: OriginalSnapshot): OriginalAmount {
    if (
      !(OriginalAmount.CURRENCIES as readonly string[]).includes(snapshot.currency) ||
      !Number.isInteger(snapshot.amount) ||
      snapshot.amount < 1 ||
      snapshot.amount > Amount.MAX ||
      !OriginalAmount.RATE.test(snapshot.rate) ||
      OriginalAmount.scaledRate(snapshot.rate) === 0n
    ) {
      throw new Error(`Corrupted original amount of ${snapshot.currency}`);
    }
    return new OriginalAmount({ ...snapshot });
  }

  get currency(): string {
    return this.value.currency;
  }

  get amount(): number {
    return this.value.amount;
  }

  get rate(): string {
    return this.value.rate;
  }

  /**
   * The amount in the group's currency: the original amount times the rate, rounded to the nearest whole number, a half
   * rounded up. Refused (InvalidAmount) when it is not from 1 to 100 000 000, as any amount is.
   */
  amountInGroupCurrency(): IResult<Amount> {
    const product = BigInt(this.value.amount) * OriginalAmount.scaledRate(this.value.rate);
    const rounded = (product + OriginalAmount.HALF) / OriginalAmount.MILLION;
    if (rounded < 1n || rounded > BigInt(Amount.MAX)) return Result.fail(new InvalidAmount(Amount.MAX));
    return Amount.create(Number(rounded));
  }

  private static readonly MILLION = 1_000_000n;
  private static readonly HALF = 500_000n;

  /** The rate as a whole number of millionths: "0.9542" is 954200, "12.5" is 12500000. */
  private static scaledRate(rate: string): bigint {
    const [whole, fraction = ''] = rate.split('.');
    return BigInt(whole + fraction.padEnd(6, '0'));
  }

  protected equalsValue(a: OriginalSnapshot, b: OriginalSnapshot): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}
