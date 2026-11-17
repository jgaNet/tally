import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense cost, in the group's currency: a whole number of its smallest unit, from 1 to 100 000 000. */
export class Amount extends ValueObject<number> {
  static readonly MAX = 100_000_000;

  private constructor(value: number) {
    super(value);
  }

  static create(raw: number): IResult<Amount> {
    if (!Number.isInteger(raw) || raw < 1 || raw > Amount.MAX) {
      return Result.fail(new InvalidAmount(Amount.MAX));
    }
    return Result.ok(new Amount(raw));
  }
}
