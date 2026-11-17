import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense was for: 1 to 100 characters, not only spaces. */
export class Description extends ValueObject<string> {
  static readonly MAX_LENGTH = 100;

  private constructor(text: string) {
    super(text);
  }

  static create(raw: string): IResult<Description> {
    const length = Array.from(raw).length;
    if (raw.trim().length === 0 || length > Description.MAX_LENGTH) return Result.fail(new InvalidDescription());
    return Result.ok(new Description(raw));
  }
}
