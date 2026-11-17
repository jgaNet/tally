import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidDescriptionException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/**
 * What an expense is for: 1 to 100 characters once the surrounding spaces are taken away, and not only spaces.
 * Stored trimmed.
 */
export class ExpenseDescription extends ValueObject<string> {
  static readonly MAX_LENGTH = 100;

  private constructor(text: string) {
    super(text);
  }

  static create(raw: string): IResult<ExpenseDescription> {
    const text = raw.trim();
    if (text.length === 0 || text.length > ExpenseDescription.MAX_LENGTH) {
      return Result.fail(new InvalidDescriptionException());
    }
    return Result.ok(new ExpenseDescription(text));
  }
}
