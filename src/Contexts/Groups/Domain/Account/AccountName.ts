import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidAccountNameException } from './AccountExceptions';

/** The name an account is known by in every group: 1 to 60 characters once trimmed, never only spaces. */
export class AccountName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<AccountName> {
    const name = raw.trim();
    const length = Array.from(name).length;
    if (length < 1 || length > AccountName.MAX_LENGTH) {
      return Result.fail(new InvalidAccountNameException());
    }
    return Result.ok(new AccountName(name));
  }
}
