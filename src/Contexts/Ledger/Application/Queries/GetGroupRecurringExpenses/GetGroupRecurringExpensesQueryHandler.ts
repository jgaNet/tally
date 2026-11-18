import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringReadModel';

/** A member of the group reads its recurring expenses, the earliest set up first. For anyone else the group does not exist. */
export class GetGroupRecurringExpensesQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { groupId: string },
  IResult<RecurringReadModel[]>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<RecurringReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const recurring = await this.queries.listByGroup(groupId);
    const members = await this.groupMembers.currentMembers(new Id(groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    return Result.ok(recurring);
  }
}
