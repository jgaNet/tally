import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidPassword } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** A password as someone chose it: long enough. It is never stored, only its hash is. */
export class Password extends ValueObject<string> {
  static readonly MIN_LENGTH = 8;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<Password> {
    if (raw.length < Password.MIN_LENGTH) return Result.fail(new InvalidPassword(Password.MIN_LENGTH));
    return Result.ok(new Password(raw));
  }
}
