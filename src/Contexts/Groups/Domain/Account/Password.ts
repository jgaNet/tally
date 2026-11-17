import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { PasswordTooShortException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** A password as it was typed: at least 8 characters. It is only ever hashed (IPasswordHasher), never stored as it is. */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(password: string) {
    super(password);
  }

  static create(raw: string): IResult<Password> {
    if (raw.length < Password.MIN_LENGTH) {
      return Result.fail(new PasswordTooShortException());
    }
    return Result.ok(new Password(raw));
  }
}
