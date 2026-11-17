import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member reads an expense of their group. To anyone who is not a member of the expense's group, the expense
 * does not exist: the answer is the same as for one that is not there. Membership is asked of Groups, through the port.
 */
export class GetExpenseQueryHandler extends QueryHandler<IExpenseQueries, { id: string }, IResult<ExpenseView>> {
  constructor(
    queries: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<ExpenseView>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const expense = await this.queries.findExpense(id);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));

    const members = await this.groupMembers.membersOf(expense.groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));

    return Result.ok(expense);
  }
}
