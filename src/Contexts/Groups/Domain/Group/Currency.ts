import { CURRENCY_CODES, isCurrencyCode } from '@SharedKernel/Domain';
import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidCurrency } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The currency of a group, chosen when it is created and never changed: every amount of the group is in it, in the minor
 * unit of that currency (hundredths for euros, none for yen, thousandths for dinars), so an amount is an integer number of
 * that minor unit (request 40, ADR 30).
 */
export class Currency extends ValueObject<string> {
  static readonly CODES = CURRENCY_CODES;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<Currency> {
    if (!isCurrencyCode(raw)) {
      return Result.fail(new InvalidCurrency(Currency.CODES));
    }
    return Result.ok(new Currency(raw));
  }
}
