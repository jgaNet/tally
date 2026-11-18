import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ITemplateQueries } from '@Contexts/Ledger/Application/Ports/ITemplateQueries';
import { TemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/TemplateReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group reads its templates, the earliest saved first, each with the split it was given (request 25). For
 * anyone who is not a member the group does not exist.
 */
export class GetGroupTemplatesQueryHandler extends QueryHandler<
  ITemplateQueries,
  { groupId: string },
  IResult<TemplateReadModel[]>
> {
  constructor(
    queries: ITemplateQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<TemplateReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }
    return Result.ok(await this.queries.ofGroup(groupId));
  }
}
