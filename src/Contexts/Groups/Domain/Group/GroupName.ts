import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidGroupName } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** What a group is called: 1 to 60 characters, not only spaces. */
export class GroupName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<GroupName> {
    const length = Array.from(raw).length;
    if (raw.trim().length === 0 || length > GroupName.MAX_LENGTH) return Result.fail(new InvalidGroupName());
    return Result.ok(new GroupName(raw));
  }
}
