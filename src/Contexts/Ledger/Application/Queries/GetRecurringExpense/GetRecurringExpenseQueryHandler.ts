import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringExpenseReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a recurring expense's group reads it. For anyone else it does not exist, the same answer as one that is
 * not there.
 */
export class GetRecurringExpenseQueryHandler extends QueryHandler<
  IRecurringExpenseQueries,
  { id: string },
  IResult<RecurringExpenseReadModel>
> {
  constructor(
    queries: IRecurringExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<RecurringExpenseReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const recurring = await this.queries.findById(id);
    if (!recurring) return Result.fail(notFound(id));
    if (!(await this.groupMembers.isMember(recurring.groupId, caller.data))) return Result.fail(notFound(id));
    return Result.ok(recurring);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Recurring expense not found', { id });
