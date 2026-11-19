import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { CURRENCIES, CurrencyCode } from '@SharedKernel/Domain';

import { InvalidCurrencyException } from './GroupExceptions';

/**
 * The currencies a group may be in, fixed when it is created (the shared kernel's list, ADR 18). Every amount of a group is an
 * integer number of the minor unit of its currency (ADR 38): `1250` in a `EUR` group is 12.50 euros, in a `JPY` group 1250 yen, in a `KWD` one 1.250 dinars.
 */
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
