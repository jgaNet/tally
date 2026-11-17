import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';

/**
 * A signed-in person lists the members of a group they are a member of, in the order they joined, the owner first. For
 * anyone else the group does not exist.
 */
export class GetGroupMembersQueryHandler extends QueryHandler<
  IGroupQueries,
  { id: string },
  IResult<MemberReadModel[]>
> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<MemberReadModel[]>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const members = await this.queries.listMembers(id, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Groups', 'Group not found', { id }));
    return Result.ok(members);
  }
}
