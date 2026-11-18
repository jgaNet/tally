import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import {
  InvalidAmount,
  InvalidOriginalAmount,
  InvalidOriginalCurrency,
  InvalidRate,
  SameCurrencyAsGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense was paid in, when it was not paid in the group's currency: its currency, its amount in hundredths, and the rate. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  /** The rate as the payer gave it: kept as the string it was written as, read back the same. */
  rate: string;
}

/**
 * What an expense was paid in another currency than its group's (request 21): the currency, the amount in its hundredths,
 * and the rate, what one of that currency is worth in the group's currency. The amount in the group's currency is the
 * original amount times the rate, rounded to the nearest whole number, a half rounded up, in exact decimal arithmetic:
 * the rate is read as a whole number of millionths, never a floating point number.
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
   * An amount paid in `currency`, when the group is in `groupCurrency`. The currency must be one of Tally's and not the
   * group's; the amount a whole number of hundredths from 1 to 100 000 000; the rate a decimal number greater than 0 with
   * at most six digits after the point.
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
    if (!(OriginalAmount.CURRENCIES as readonly string[]).includes(currency)) {
      return Result.fail(new InvalidOriginalCurrency(OriginalAmount.CURRENCIES));
    }
    if (currency === groupCurrency) return Result.fail(new SameCurrencyAsGroup());
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
