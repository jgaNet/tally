import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member lists the expenses of their group that are not deleted, each as it reads on its own: the latest date
 * first, then the most recently recorded first (request 8). To anyone who is not a member the group does not exist.
 * Membership is asked of Groups, through the port.
 */
export class GetGroupExpensesQueryHandler extends QueryHandler<
  IExpenseQueries,
  { groupId: string },
  IResult<ExpenseView[]>
> {
  constructor(
    queries: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<ExpenseView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    return Result.ok(await this.queries.listGroupExpenses(groupId));
  }
}
