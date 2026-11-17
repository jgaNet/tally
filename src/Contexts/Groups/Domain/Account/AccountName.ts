import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidAccountNameException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The name an account is known by in every group: 1 to 60 characters, not only spaces. Surrounding spaces
 * are not part of it, so it is kept trimmed. Built through `create()`, which refuses a name out of range.
 */
export class AccountName extends ValueObject<string> {
  static readonly MIN_LENGTH = 1;
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<AccountName> {
    const name = raw.trim();
    const length = Array.from(name).length;
    if (length < AccountName.MIN_LENGTH || length > AccountName.MAX_LENGTH) {
      return Result.fail(new InvalidAccountNameException());
    }
    return Result.ok(new AccountName(name));
  }
}
