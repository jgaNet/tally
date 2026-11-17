import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidGroupName } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** What a group is called: 1 to 60 characters, not only spaces. */
export class GroupName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(value: string) {
    super(value);
  }

  static create(raw: string): IResult<GroupName> {
    if (raw.length < 1 || raw.length > GroupName.MAX_LENGTH || raw.trim() === '') {
      return Result.fail(new InvalidGroupName(GroupName.MAX_LENGTH));
    }
    return Result.ok(new GroupName(raw));
  }
}
