import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidAccountName } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** How the other people of someone's groups see them: 1 to 60 characters, not only spaces. */
export class AccountName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<AccountName> {
    if (raw.length < 1 || raw.length > AccountName.MAX_LENGTH || raw.trim() === '') {
      return Result.fail(new InvalidAccountName(AccountName.MAX_LENGTH));
    }
    return Result.ok(new AccountName(raw));
  }
}
