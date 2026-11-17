import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidExpenseDescriptionException } from './ExpenseExceptions';

/** What an expense is for: 1 to 100 characters once trimmed, never only spaces. */
export class ExpenseDescription extends ValueObject<string> {
  static readonly MAX_LENGTH = 100;

  private constructor(description: string) {
    super(description);
  }

  static create(raw: string): IResult<ExpenseDescription> {
    const description = raw.trim();
    const length = Array.from(description).length;
    if (length < 1 || length > ExpenseDescription.MAX_LENGTH) {
      return Result.fail(new InvalidExpenseDescriptionException());
    }
    return Result.ok(new ExpenseDescription(description));
  }
}
