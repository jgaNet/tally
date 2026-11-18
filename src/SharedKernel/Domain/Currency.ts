import { Exception, IResult, Result, ValueObject } from '@Architecture/Domain';

/**
 * The currencies Tally knows (requests 2 and 40), each with the number of decimals of its minor unit: two for the six that count in
 * hundredths (cents, pence), none for yen and won, which have no minor unit, three for dinars, which count in thousandths. Every amount
 * of Tally is a whole number of the minor unit of the currency it is in: `1250` is 12.50 euros and 1250 yen (request 40).
 */
const DECIMALS = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
} as const;

export type CurrencyCode = keyof typeof DECIMALS;

/** A rate is read as a whole number of millionths, so that a rate and the amounts converted at it are exact (requests 21, 22). */
export const RATE_SCALE = 1_000_000n;

/** A currency that is not one of Tally's: `422` (ADR 5, request 40). The codes are exact: `eur` is not `EUR`. */
export class UnsupportedCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'UnsupportedCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD or BHD',
    });
  }
}

/**
 * The currency of a group, one of the ten codes of Tally, each with its own minor unit (ADR 32). The one word every context agrees on:
 * Groups creates a group in it, Ledger and Settlements convert an amount to it (`convertMinorUnits`), and Notifications compares a debt
 * with 20 of it (`minorUnitsOf`). Chosen when the group is created and never changed (ADR 5). The codes are exact.
 */
export class Currency extends ValueObject<string> {
  static readonly CODES: readonly CurrencyCode[] = Object.keys(DECIMALS) as CurrencyCode[];

  private constructor(code: string) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!Currency.isCode(raw)) return Result.fail(new UnsupportedCurrencyException());
    return Result.ok(new Currency(raw));
  }

  /** Whether the code is one of Tally's ten, exactly. */
  static isCode(raw: string): raw is CurrencyCode {
    return Object.prototype.hasOwnProperty.call(DECIMALS, raw);
  }

  /** The number of decimals of the currency's minor unit: 2, 0 or 3. Throws on a code that is not Tally's, a programming error. */
  static decimalsOf(code: string): number {
    if (!Currency.isCode(code)) throw new Error(`The currency ${code} is not one of Tally's`);
    return DECIMALS[code];
  }
}

/** `units` whole units of a currency, in its minor unit: `minorUnitsOf('EUR', 20)` is 2000, `minorUnitsOf('JPY', 20)` is 20. */
export const minorUnitsOf = (code: string, units: number): number => units * 10 ** Currency.decimalsOf(code);

/**
 * An amount in one currency's minor unit, read at a rate (the millionths of the other currency one unit of the first is worth), in the
 * other's minor unit: the amount times the rate, rounded to the nearest whole number, a half up, in exact integers (requests 21, 22, 39, 40).
 * Each minor unit is the power of ten its decimals give: 1250 euros-cents at `161.5` is 2018.75 yen, so 2019; 1000 dollars-cents at `0.3075`
 * is 3.075 dinars, so 3075 thousandths. Between two currencies of the same decimals it is the same as it always was.
 */
export const convertMinorUnits = (amount: bigint, from: string, to: string, rateMillionths: bigint): bigint => {
  const numerator = amount * rateMillionths * 10n ** BigInt(Currency.decimalsOf(to));
  const denominator = 10n ** BigInt(Currency.decimalsOf(from)) * RATE_SCALE;
  return (2n * numerator + denominator) / (2n * denominator);
};
