import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IBudgetQueries } from '@Contexts/Ledger/Application/Ports/IBudgetQueries';
import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group reads its budgets: each category that has one, in the order of the categories, with its amount and
 * what the current month, in UTC, spends in it (request 24). For anyone who is not a member the group does not exist. The month is
 * the one of the application's clock.
 */
export class GetGroupBudgetsQueryHandler extends QueryHandler<
  IBudgetQueries,
  { groupId: string },
  IResult<BudgetReadModel[]>
> {
  constructor(
    queries: IBudgetQueries,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<BudgetReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }
    return Result.ok(await this.queries.ofGroup(groupId, this.clock().toISOString().slice(0, 7)));
  }
}
