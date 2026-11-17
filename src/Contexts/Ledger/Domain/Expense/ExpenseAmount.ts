import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidAmountException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** The amount of an expense, in the group's currency: a whole number from 1 to 100 000 000 (its smallest unit). */
export class ExpenseAmount extends ValueObject<number> {
  static readonly MIN = 1;
  static readonly MAX = 100_000_000;

  private constructor(amount: number) {
    super(amount);
  }

  static create(raw: number): IResult<ExpenseAmount> {
    if (!Number.isInteger(raw) || raw < ExpenseAmount.MIN || raw > ExpenseAmount.MAX) {
      return Result.fail(new InvalidAmountException());
    }
    return Result.ok(new ExpenseAmount(raw));
  }
}
