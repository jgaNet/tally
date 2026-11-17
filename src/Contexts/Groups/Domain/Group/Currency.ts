import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidCurrencyException } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { CURRENCIES, CurrencyCode } from '@SharedKernel/Domain/Currency';

/** The currencies a group may be in: Tally's, kept in the shared kernel (request 21 reads the same list). */
export { CURRENCIES };
export type { CurrencyCode };

/**
 * The currency of a group, chosen when the group is created and never changed: every amount of the group is in it.
 */
export class Currency extends ValueObject<CurrencyCode> {
  private constructor(code: CurrencyCode) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    const code = CURRENCIES.find(known => known === raw);
    return code ? Result.ok(new Currency(code)) : Result.fail(new InvalidCurrencyException());
  }
}
