import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import {
  IRecurringExpenseQueries,
  RecurringExpenseView,
} from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';

/**
 * A signed-in member reads a recurring expense of their group (request 23). To anyone who is not a member of its group, it does
 * not exist: the answer is the same as for one that is not there. Membership is asked of Groups, through the port.
 */
export class GetRecurringExpenseQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { id: string },
  IResult<RecurringExpenseView>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<RecurringExpenseView>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const recurring = await this.queries.findRecurring(id);
    if (!recurring) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));

    const members = await this.groupMembers.membersOf(recurring.groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));

    return Result.ok(recurring);
  }
}
