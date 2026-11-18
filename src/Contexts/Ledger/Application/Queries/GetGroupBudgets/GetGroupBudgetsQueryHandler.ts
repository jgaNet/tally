import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { BudgetView, IBudgetQueries } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member reads the budgets of their group (request 24): each category that has one, in the order of the categories,
 * with its amount and what the current month spends in it (UTC, from the application's clock). To anyone who is not a member of
 * the group, the group does not exist.
 */
export class GetGroupBudgetsQueryHandler extends QueryHandler<
  IBudgetQueries,
  { groupId: string },
  IResult<BudgetView[]>
> {
  constructor(
    queries: IBudgetQueries,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<BudgetView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const month = this.clock().toISOString().slice(0, 7);
    return Result.ok(await this.queries.listGroupBudgets(groupId, month));
  }
}
