import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { PasswordTooShortException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The password an account signs in with, as it was given: at least 8 characters. It is held only for the
 * registration or the sign-in that has it; what is kept is the hasher's hash, never this value.
 */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(secret: string) {
    super(secret);
  }

  static create(raw: string): IResult<Password> {
    if (Array.from(raw).length < Password.MIN_LENGTH) {
      return Result.fail(new PasswordTooShortException());
    }
    return Result.ok(new Password(raw));
  }
}
