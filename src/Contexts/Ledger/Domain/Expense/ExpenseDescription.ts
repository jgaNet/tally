import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidExpenseDescriptionException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * What an expense was for: 1 to 100 characters, not only spaces. Surrounding spaces are not part of it, so it is kept
 * trimmed. Built through `create()`, which refuses a description out of range.
 */
export class ExpenseDescription extends ValueObject<string> {
  static readonly MIN_LENGTH = 1;
  static readonly MAX_LENGTH = 100;

  private constructor(description: string) {
    super(description);
  }

  static create(raw: string): IResult<ExpenseDescription> {
    const description = raw.trim();
    const length = Array.from(description).length;
    if (length < ExpenseDescription.MIN_LENGTH || length > ExpenseDescription.MAX_LENGTH) {
      return Result.fail(new InvalidExpenseDescriptionException());
    }
    return Result.ok(new ExpenseDescription(description));
  }
}
