import { IResult, Result } from '@Architecture/Domain/Result';
import { ValueObject } from '@Architecture/Domain/ValueObject';
import { Exception } from '@Architecture/Domain/Exception';

/**
 * The currencies Tally counts in, each with its number of decimals: the minor unit of an amount in a currency is `10^decimals`
 * of its unit (cents, pence, yen, dinars). Six count in hundredths (request 2); yen and won have no minor unit (request 40);
 * dinars count in thousandths. Every context reads a currency's minor unit from here, and no context keeps its own list
 * (ADR 25).
 */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
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
});

/** The codes of Tally's currencies, in the order they are listed. */
export const CURRENCIES: readonly string[] = Object.freeze(Object.keys(CURRENCY_DECIMALS));

/** Whether `code` is one of Tally's currencies. */
export function isCurrency(code: unknown): code is string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_DECIMALS, code);
}

/**
 * The number of decimals of one of Tally's currencies: 2 for hundredths, 0 for none, 3 for thousandths. Read only for a code
 * that `isCurrency` accepts; any other code is a programming error and throws.
 */
export function decimalsOf(code: string): number {
  if (!isCurrency(code)) throw new Error(`Not a currency of Tally: ${code}`);
  return CURRENCY_DECIMALS[code];
}

/**
 * A currency of Tally, by its code: the word every context agrees on for what an amount is counted in. Built through `create()`,
 * which refuses a code Tally does not count in by name. `decimals` is the number of decimals of its minor unit; `minorUnit` is
 * the number of minor units in one unit of the currency (100 for EUR, 1 for JPY, 1000 for KWD).
 */
export class Currency extends ValueObject<string> {
  private constructor(code: string) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!isCurrency(raw)) return Result.fail(new UnknownCurrencyCode({ code: String(raw) }));
    return Result.ok(new Currency(raw));
  }

  get code(): string {
    return this.value;
  }

  get decimals(): number {
    return decimalsOf(this.value);
  }

  get minorUnit(): number {
    return 10 ** this.decimals;
  }
}

export class UnknownCurrencyCode extends Exception {
  constructor({ service, code }: { service?: string; code: string }) {
    super({
      service: service || 'unknown',
      type: 'UnknownCurrencyCode',
      message: 'Not a currency Tally counts in',
      context: { code },
    });
  }
}
