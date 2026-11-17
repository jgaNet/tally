import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupQueries, MemberView } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

/**
 * A signed-in member lists a group's members, in the order they joined, the owner first. For anyone who is not a
 * member the group does not exist, so the answer is the same as for a group that is not there.
 */
export class GetGroupMembersQueryHandler extends QueryHandler<
  IGroupQueries,
  { groupId: string },
  IResult<MemberView[]>
> {
  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<MemberView[]>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.queries.listMembersOf(caller.data.value, groupId);
    if (!members) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    return Result.ok(members);
  }
}
