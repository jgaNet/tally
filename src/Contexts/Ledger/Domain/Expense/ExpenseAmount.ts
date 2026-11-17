import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidExpenseAmountException } from './ExpenseExceptions';

/** What was paid, in the group's currency, in its smallest unit: a whole number from 1 to 100 000 000. */
export class ExpenseAmount extends ValueObject<number> {
  static readonly MAX = 100_000_000;

  private constructor(amount: number) {
    super(amount);
  }

  static create(raw: number): IResult<ExpenseAmount> {
    if (!Number.isInteger(raw) || raw < 1 || raw > ExpenseAmount.MAX) {
      return Result.fail(new InvalidExpenseAmountException());
    }
    return Result.ok(new ExpenseAmount(raw));
  }
}
