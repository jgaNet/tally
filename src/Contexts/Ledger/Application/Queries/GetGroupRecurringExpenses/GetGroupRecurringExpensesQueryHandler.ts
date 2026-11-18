import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import {
  IRecurringExpenseQueries,
  RecurringExpenseView,
} from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';

/**
 * A signed-in member lists the recurring expenses of their group, the earliest set up first (request 23). To anyone who is not a
 * member of the group, the group does not exist.
 */
export class GetGroupRecurringExpensesQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { groupId: string },
  IResult<RecurringExpenseView[]>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<RecurringExpenseView[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    return Result.ok(await this.queries.listGroupRecurring(groupId));
  }
}
