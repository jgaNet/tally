import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';

/** A signed-in person lists the groups they are a member of, the most recently created first. */
export class GetMyGroupsQueryHandler extends QueryHandler<IGroupQueries, void, IResult<GroupReadModel[]>> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<GroupReadModel[]>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;
    return Result.ok(await this.queries.listForMember(caller.data.value));
  }
}
