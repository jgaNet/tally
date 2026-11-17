import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';

/**
 * A member of the group reads its expenses, each as it reads on its own, the latest date first and then the most recently
 * recorded first. For anyone else the group does not exist, the same answer as for a group that was never created.
 */
export class GetGroupExpensesQueryHandler extends QueryHandler<
  IExpenseQueries,
  { groupId: string },
  IResult<ExpenseReadModel[]>
> {
  constructor(
    queries: IExpenseQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<ExpenseReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    // The expenses are read before the members, as the balances are (GetGroupBalances).
    const expenses = await this.queries.listByGroup(groupId);
    const members = await this.groupMembers.currentMembers(new Id(groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    return Result.ok(expenses);
  }
}
