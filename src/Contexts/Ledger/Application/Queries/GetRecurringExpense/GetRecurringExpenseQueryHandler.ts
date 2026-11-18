import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringReadModel';

/** A member of the recurring expense's group reads it. For anyone else it does not exist. */
export class GetRecurringExpenseQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { id: string },
  IResult<RecurringReadModel>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<RecurringReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const recurring = await this.queries.findById(id);
    if (!recurring) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
    const members = await this.groupMembers.currentMembers(new Id(recurring.groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
    }
    return Result.ok(recurring);
  }
}
