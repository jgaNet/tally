import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidCurrency } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The currency of a group, chosen when it is created and never changed: every amount of the group is in it,
 * counted in hundredths (cents, pence), so an amount is an integer number of hundredths.
 */
export class Currency extends ValueObject<string> {
  static readonly CODES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<Currency> {
    if (!(Currency.CODES as readonly string[]).includes(raw)) {
      return Result.fail(new InvalidCurrency(Currency.CODES));
    }
    return Result.ok(new Currency(raw));
  }
}
