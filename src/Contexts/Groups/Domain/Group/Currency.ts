import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { CURRENCIES, CurrencyCode, isCurrencyCode } from '@SharedKernel/Domain/Currency';

import { InvalidCurrency } from '@Contexts/Groups/Domain/Group/GroupExceptions';

export { CURRENCIES, type CurrencyCode };

/**
 * The currency of a group, chosen when it is created and never changed: every amount of the group is in it. Each of
 * these counts in hundredths (cents, pence), so an amount is an integer number of hundredths: 1250 in EUR is 12.50 euros.
 */
export class Currency extends ValueObject<CurrencyCode> {
  /** How many hundredths make one unit of every currency of the list. */
  static readonly HUNDREDTHS_PER_UNIT = 100;

  private constructor(code: CurrencyCode) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!isCurrencyCode(raw)) return Result.fail(new InvalidCurrency());
    return Result.ok(new Currency(raw));
  }
}
