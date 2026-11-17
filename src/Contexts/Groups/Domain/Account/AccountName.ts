import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidAccountNameException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The name an account is known by in every group: 1 to 60 characters once the surrounding spaces are
 * taken away, and not only spaces. Stored trimmed.
 */
export class AccountName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<AccountName> {
    const name = raw.trim();
    if (name.length === 0 || name.length > AccountName.MAX_LENGTH) {
      return Result.fail(new InvalidAccountNameException());
    }
    return Result.ok(new AccountName(name));
  }
}
