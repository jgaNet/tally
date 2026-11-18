import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidBudgetAmountException } from './BudgetExceptions';

/** What a group agrees to spend in a category in a month, in the group's currency: a whole number from 1 to 100 000 000. */
export class BudgetAmount extends ValueObject<number> {
  static readonly MAX = 100_000_000;

  private constructor(amount: number) {
    super(amount);
  }

  static create(raw: number): IResult<BudgetAmount> {
    if (!Number.isInteger(raw) || raw < 1 || raw > BudgetAmount.MAX) {
      return Result.fail(new InvalidBudgetAmountException());
    }
    return Result.ok(new BudgetAmount(raw));
  }
}
