import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { UnsupportedCurrencyException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The currency of a group, one of six codes, each counted in hundredths (cents, pence): every amount of a group is an
 * integer number of hundredths of its currency. Chosen when the group is created and never changed (ADR 5). The codes
 * are exact: `eur` is not `EUR`.
 */
export class Currency extends ValueObject<string> {
  static readonly CODES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

  private constructor(code: string) {
    super(code);
  }

  static create(raw: string): IResult<Currency> {
    if (!(Currency.CODES as readonly string[]).includes(raw)) {
      return Result.fail(new UnsupportedCurrencyException());
    }
    return Result.ok(new Currency(raw));
  }
}
