import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** What an expense is for: 1 to 100 characters, not only spaces. */
export class Description extends ValueObject<string> {
  static readonly MAX_LENGTH = 100;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<Description> {
    const length = Array.from(raw).length;
    if (length < 1 || length > Description.MAX_LENGTH || raw.trim() === '') {
      return Result.fail(new InvalidDescription(Description.MAX_LENGTH));
    }
    return Result.ok(new Description(raw));
  }
}
