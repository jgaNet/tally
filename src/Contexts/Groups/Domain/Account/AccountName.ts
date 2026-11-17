import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidNameException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The name an account shows to the people of its groups: 1 to 60 characters, and not only spaces. Built through
 * `create()`, which refuses what it does not allow, so an `AccountName` always holds a name the domain accepts.
 */
export class AccountName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<AccountName> {
    const length = [...raw].length;
    if (raw.trim() === '' || length > AccountName.MAX_LENGTH) {
      return Result.fail(new InvalidNameException());
    }
    return Result.ok(new AccountName(raw));
  }
}
