import { IResult, Result, ValueObject } from '@Architecture/Domain';
import {
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  NoRateOffered,
  SameCurrencyAsGroup,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * The rate a rates service offers for a currency to the group's on a day (request 39, ADR 15 as Ledger holds it), as the port
 * answers it: a plain value the settlement takes or refuses, never a call from the domain. `offered` carries the rate as the
 * service writes it; `none` is a service that offers no rate for it (a 404, an answer it does not give, or no answer in time);
 * `unconfigured` is a server started without a rates service, which offers no rate at all.
 */
export type RateOffer = { kind: 'offered'; rate: string } | { kind: 'none' } | { kind: 'unconfigured' };

/** What a settlement was paid in, when it was another currency than its group's: its currency, its hundredths, and the rate. */
export interface OriginalAmountSnapshot {
  readonly currency: string;
  readonly amount: number;
  /** The rate as the rates service wrote it, kept as the string it was written as. */
  readonly rate: string;
}

/** A payment in another currency as a command gives it: the currency and the hundredths, the group's currency, and the offer of the day. */
export interface OtherCurrencyPayment {
  readonly currency: string;
  readonly amount: number;
  readonly groupCurrency: string;
  readonly offer: RateOffer;
}

/**
 * A settlement paid in another currency than its group's (request 39): the currency, the amount in its hundredths, and the rate
 * at which it was decided, what one of that currency is worth in the group's. The rate is taken from the rates service's offer
 * when the settlement is decided, and never given by the payer; with no offer, the settlement is refused. The amount in the
 * group's currency is the original amount times the rate, rounded to the nearest whole number, a half rounded up, in exact
 * integer arithmetic: the rate is read as a whole number of millionths. The provider's fee is converted by the same rate.
 */
export class OriginalAmount extends ValueObject<OriginalAmountSnapshot> {
  /** Tally's currencies, as Groups has them (request 2): the group's own is not one a settlement is paid in other than. */
  static readonly CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
  /** The largest amount in another currency, in its hundredths (request 39). */
  static readonly MAX_HUNDREDTHS = 100_000_000;

  private static readonly RATE = /^\d+(\.\d{1,6})?$/;
  private static readonly MILLION = 1_000_000n;
  private static readonly HALF = 500_000n;

  private constructor(value: OriginalAmountSnapshot) {
    super(value);
  }

  /** Whether a settlement may be paid in `currency` when the group is in `groupCurrency`: one of Tally's, and not the group's. */
  static checkCurrency(currency: string, groupCurrency: string): IResult {
    if (!(OriginalAmount.CURRENCIES as readonly string[]).includes(currency)) {
      return Result.fail(new InvalidOriginalCurrency(OriginalAmount.CURRENCIES));
    }
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsGroup());
    return Result.ok();
  }

  /**
   * The rate taken from the offer, or the refusal by name (NoRateOffered) when the service offers none, or no service is
   * configured: a settlement in another currency is never kept at a rate nobody offered.
   */
  static takeRate(offer: RateOffer): IResult<string> {
    if (offer.kind !== 'offered') return Result.fail(new NoRateOffered());
    return Result.ok(offer.rate);
  }

  /**
   * A payment in another currency, decided on the offer it is given: the currency is checked first, then the amount, then the
   * rate is taken from the offer. Nothing is kept by this method: it is the value the book keeps when the settlement is.
   */
  static decide({ currency, amount, groupCurrency, offer }: OtherCurrencyPayment): IResult<OriginalAmount> {
    const inCurrency = OriginalAmount.checkCurrency(currency, groupCurrency);
    if (inCurrency.isFailure()) return inCurrency;
    if (!Number.isInteger(amount) || amount < 1 || amount > OriginalAmount.MAX_HUNDREDTHS) {
      return Result.fail(new InvalidOriginalAmount(OriginalAmount.MAX_HUNDREDTHS));
    }
    const rate = OriginalAmount.takeRate(offer);
    if (rate.isFailure()) return rate;
    return Result.ok(new OriginalAmount({ currency, amount, rate: rate.data }));
  }

  /** A settlement as it was stored: its values were checked when it was decided, and corrupted data is refused by throwing. */
  static fromSnapshot(snapshot: OriginalAmountSnapshot): OriginalAmount {
    if (
      !(OriginalAmount.CURRENCIES as readonly string[]).includes(snapshot.currency) ||
      !Number.isInteger(snapshot.amount) ||
      snapshot.amount < 1 ||
      snapshot.amount > OriginalAmount.MAX_HUNDREDTHS ||
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

  /** The snapshot a settlement keeps: its currency, its hundredths and its rate. */
  snapshot(): OriginalAmountSnapshot {
    return { ...this.value };
  }

  /** The amount in the group's currency: the original amount times the rate, a half rounded up. Its range is the settlement's. */
  amountInGroupCurrency(): number {
    return this.convert(this.value.amount);
  }

  /**
   * An amount of `hundredths` in the original currency, converted at this rate into the group's currency, a half rounded up
   * (request 39): the provider's fee is converted so (0 is a fee of nothing).
   */
  convert(hundredths: number): number {
    const product = BigInt(hundredths) * OriginalAmount.scaledRate(this.value.rate);
    return Number((product + OriginalAmount.HALF) / OriginalAmount.MILLION);
  }

  /** The rate as a whole number of millionths: "0.9542" is 954200, "12.5" is 12500000. */
  private static scaledRate(rate: string): bigint {
    const [whole, fraction = ''] = rate.split('.');
    return BigInt(whole + fraction.padEnd(6, '0'));
  }

  protected equalsValue(a: OriginalAmountSnapshot, b: OriginalAmountSnapshot): boolean {
    return a.currency === b.currency && a.amount === b.amount && a.rate === b.rate;
  }
}
