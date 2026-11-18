import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISplitTemplateQueries, TemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member reads the split templates of their group (request 25): each with its id, its group, its name and the split as it
 * was given, the earliest saved first. To anyone who is not a member of the group, the group does not exist.
 */
export class GetGroupTemplatesQueryHandler extends QueryHandler<
  ISplitTemplateQueries,
  { groupId: string },
  IResult<TemplateView[]>
> {
  constructor(
    queries: ISplitTemplateQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<TemplateView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    return Result.ok(await this.queries.listGroupTemplates(groupId));
  }
}
