import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * What an expense cost, in the group's currency, counted in its smallest unit (hundredths, as Groups keeps a group's
 * currency): a whole number from 1 to 100 000 000.
 */
export class Amount extends ValueObject<number> {
  static readonly MIN = 1;
  static readonly MAX = 100_000_000;

  private constructor(hundredths: number) {
    super(hundredths);
  }

  static create(raw: number): IResult<Amount> {
    if (!Number.isInteger(raw) || raw < Amount.MIN || raw > Amount.MAX) return Result.fail(new InvalidAmount());
    return Result.ok(new Amount(raw));
  }
}
