import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringExpenseReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group lists its recurring expenses, the earliest set up first. For anyone who is not a member the group
 * does not exist.
 */
export class GetGroupRecurringExpensesQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { groupId: string },
  IResult<RecurringExpenseReadModel[]>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId }: { groupId: string },
    context: ExecutionContext,
  ): Promise<IResult<RecurringExpenseReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }
    return Result.ok(await this.queries.ofGroup(groupId));
  }
}
