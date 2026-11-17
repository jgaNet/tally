import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { GroupView, IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';

/** A signed-in person lists the groups they are a member of, the most recently created first. */
export class GetMyGroupsQueryHandler extends QueryHandler<IGroupQueries, undefined, IResult<GroupView[]>> {
  async execute(_: undefined, context: ExecutionContext): Promise<IResult<GroupView[]>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    return Result.ok(await this.queries.listGroupsOf(caller.data.value));
  }
}
