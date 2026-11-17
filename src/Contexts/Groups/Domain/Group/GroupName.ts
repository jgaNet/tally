import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidGroupNameException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The name of a group: 1 to 60 characters, not only spaces. Surrounding spaces are not part of it, so it is
 * kept trimmed. Built through `create()`, which refuses a name out of range.
 */
export class GroupName extends ValueObject<string> {
  static readonly MIN_LENGTH = 1;
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<GroupName> {
    const name = raw.trim();
    const length = Array.from(name).length;
    if (length < GroupName.MIN_LENGTH || length > GroupName.MAX_LENGTH) {
      return Result.fail(new InvalidGroupNameException());
    }
    return Result.ok(new GroupName(name));
  }
}
