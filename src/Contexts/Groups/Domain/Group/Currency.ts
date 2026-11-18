import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { UnsupportedCurrencyException } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { CURRENCIES, isCurrency } from '@SharedKernel/Domain/Currency';

export { CURRENCIES };

/**
 * The currencies a group may be in (request 2, and request 40: the yen, the won, the dinar and the Bahraini dinar as well). Each
 * counts in its own minor unit (`decimals` in the shared kernel): an amount of a group is an integer number of that minor unit,
 * so 1250 is 12.50 in a currency of hundredths and 1250 yen in JPY. Chosen when the group is created, and never changed after.
 */
export class Currency extends ValueObject<string> {
  private constructor(code: string) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!isCurrency(raw)) return Result.fail(new UnsupportedCurrencyException());
    return Result.ok(new Currency(raw));
  }
}
