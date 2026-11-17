import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { UnsupportedCurrencyException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The currencies a group may be in. Each counts in hundredths (cents, pence): every amount of a group is an
 * integer number of hundredths of its currency. Chosen when the group is created, and never changed after.
 */
export const CURRENCIES: readonly string[] = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'];

export class Currency extends ValueObject<string> {
  private constructor(code: string) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!CURRENCIES.includes(raw)) return Result.fail(new UnsupportedCurrencyException());
    return Result.ok(new Currency(raw));
  }
}
