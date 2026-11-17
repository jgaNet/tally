import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidCurrencyException } from './GroupExceptions';

/**
 * The currencies a group may be in, fixed when it is created. Each counts in hundredths (cents, pence): every amount
 * of a group is an integer number of hundredths of its currency, so `1250` in a `EUR` group is 12.50 euros.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export class Currency extends ValueObject<CurrencyCode> {
  private constructor(code: CurrencyCode) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    const code = CURRENCIES.find(currency => currency === raw);
    if (code === undefined) return Result.fail(new InvalidCurrencyException());
    return Result.ok(new Currency(code));
  }
}
