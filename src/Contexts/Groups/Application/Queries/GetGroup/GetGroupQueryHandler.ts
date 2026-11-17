import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';

/** A signed-in person reads a group they are a member of. For anyone else it does not exist. */
export class GetGroupQueryHandler extends QueryHandler<IGroupQueries, { id: string }, IResult<GroupReadModel>> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<GroupReadModel>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;
    const group = await this.queries.findForMember(id, caller.data.value);
    return group ? Result.ok(group) : Result.fail(new NotFoundException('Groups', 'Group not found'));
  }
}
