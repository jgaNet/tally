import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group lists its expenses that have not been deleted, each as it reads on its own: the latest date
 * first, and on the same date the most recently recorded first (an edit does not change when an expense was recorded). For
 * anyone who is not a member the group does not exist. The membership is asked of Groups through the port Ledger owns (ADR 3).
 */
export class GetGroupExpensesQueryHandler extends QueryHandler<
  IExpenseQueries,
  { groupId: string },
  IResult<ExpenseReadModel[]>
> {
  constructor(
    queries: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<ExpenseReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }

    // `ofGroup` answers the expenses in the order they were recorded, the earliest first: an expense's place in it is its
    // recording order, so the sort on the same date can read it from the index.
    const recorded = await this.queries.ofGroup(groupId);
    const latestFirst = recorded
      .map((expense, order) => ({ expense, order }))
      .sort((a, b) => compare(b.expense.date, a.expense.date) || b.order - a.order);
    return Result.ok(latestFirst.map(({ expense }) => expense));
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
