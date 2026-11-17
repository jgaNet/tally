import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidCurrencyException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** The currencies a group may be in. Each counts in hundredths (cents, pence): every amount of a group is an integer of them. */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

export type CurrencyCode = (typeof CURRENCIES)[number];

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
