import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of an expense's group reads it. For anyone else it does not exist: the membership is asked of
 * Groups through the port Ledger owns, the same answer as an expense that is not there.
 */
export class GetExpenseQueryHandler extends QueryHandler<IExpenseQueries, { id: string }, IResult<ExpenseReadModel>> {
  constructor(
    queries: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<ExpenseReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.queries.findById(id);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found', { id }));

    if (!(await this.groupMembers.isMember(expense.groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Expense not found', { id }));
    }
    return Result.ok(expense);
  }
}
