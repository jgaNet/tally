import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidName } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** How the other people of a person's groups see them: 1 to 60 characters, not only spaces. */
export class Name extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<Name> {
    const length = Array.from(raw).length;
    if (raw.trim().length === 0 || length > Name.MAX_LENGTH) return Result.fail(new InvalidName());
    return Result.ok(new Name(raw));
  }
}
