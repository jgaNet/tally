import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidPasswordException } from './AccountExceptions';

/**
 * A password as it was typed, checked for its length and nothing else. It is never stored: the account keeps
 * the hash the infrastructure made of it, and this value lives only as long as the sign-up that carries it.
 */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(password: string) {
    super(password);
  }

  static create(raw: string): IResult<Password> {
    if (Array.from(raw).length < Password.MIN_LENGTH) {
      return Result.fail(new InvalidPasswordException());
    }
    return Result.ok(new Password(raw));
  }
}
