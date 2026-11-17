import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { WeakPasswordException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The password an account is signed up with: at least 8 characters. It is checked here, as typed, and then
 * only its hash is kept (the password port makes it); a `Password` is never stored.
 */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(password: string) {
    super(password);
  }

  static create(raw: string): IResult<Password> {
    if ([...raw].length < Password.MIN_LENGTH) {
      return Result.fail(new WeakPasswordException());
    }
    return Result.ok(new Password(raw));
  }
}
