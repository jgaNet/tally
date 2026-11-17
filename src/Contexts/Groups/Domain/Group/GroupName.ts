import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidGroupNameException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * The name of a group: 1 to 60 characters once the surrounding spaces are taken away, and not only spaces.
 * Stored trimmed.
 */
export class GroupName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<GroupName> {
    const name = raw.trim();
    if (name.length === 0 || name.length > GroupName.MAX_LENGTH) {
      return Result.fail(new InvalidGroupNameException());
    }
    return Result.ok(new GroupName(name));
  }
}
