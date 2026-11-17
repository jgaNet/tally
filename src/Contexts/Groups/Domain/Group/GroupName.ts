import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidGroupNameException } from './GroupExceptions';

/** The name a group is known by: 1 to 60 characters once trimmed, never only spaces. */
export class GroupName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<GroupName> {
    const name = raw.trim();
    const length = Array.from(name).length;
    if (length < 1 || length > GroupName.MAX_LENGTH) {
      return Result.fail(new InvalidGroupNameException());
    }
    return Result.ok(new GroupName(name));
  }
}
