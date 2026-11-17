import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { GroupView, IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

/** A signed-in person reads a group they are a member of. For anyone else the group does not exist. */
export class GetGroupQueryHandler extends QueryHandler<IGroupQueries, { id: string }, IResult<GroupView>> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<GroupView>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const group = await this.queries.findGroupOf(caller.data.value, id);
    if (!group) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    return Result.ok(group);
  }
}
