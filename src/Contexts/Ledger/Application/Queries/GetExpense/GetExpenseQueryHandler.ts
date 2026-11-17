import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

/**
 * A member of the expense's group reads it. For anyone else it does not exist: the members are asked of Groups, the
 * same answer as for an expense that was never recorded.
 */
export class GetExpenseQueryHandler extends QueryHandler<IExpenseQueries, { id: string }, IResult<ExpenseReadModel>> {
  constructor(
    queries: IExpenseQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<ExpenseReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.queries.findById(id);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const members = await this.groupMembers.currentMembers(new Id(expense.groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    }
    return Result.ok(expense);
  }
}
