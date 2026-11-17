import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidGroupNameException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The name of a group: 1 to 60 characters, and not only spaces. Built through `create()`, which refuses what it does not
 * allow, so a `GroupName` always holds a name the domain accepts.
 */
export class GroupName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<GroupName> {
    const length = [...raw].length;
    if (raw.trim() === '' || length > GroupName.MAX_LENGTH) {
      return Result.fail(new InvalidGroupNameException());
    }
    return Result.ok(new GroupName(raw));
  }
}
