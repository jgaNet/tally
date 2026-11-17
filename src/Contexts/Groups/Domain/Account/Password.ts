import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { PasswordTooShort } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** What someone typed as a password, once it is long enough: it is never kept, only its hash is. */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(password: string) {
    super(password);
  }

  static create(raw: string): IResult<Password> {
    if (Array.from(raw).length < Password.MIN_LENGTH) return Result.fail(new PasswordTooShort(Password.MIN_LENGTH));
    return Result.ok(new Password(raw));
  }
}
