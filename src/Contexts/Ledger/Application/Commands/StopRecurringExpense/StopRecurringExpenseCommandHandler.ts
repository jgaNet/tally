import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense/StopRecurringExpenseCommandEvent';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';

/**
 * A signed-in member of a recurring expense's group stops it: its payer or the group's owner may. For anyone who is not a member
 * it does not exist. It is deleted; the expenses it recorded stay.
 */
export class StopRecurringExpenseCommandHandler extends CommandHandler<StopRecurringExpenseCommandEvent> {
  constructor(
    private recurringExpenses: IRecurringExpenseRepository,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: StopRecurringExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const recurring = await this.recurringExpenses.findById(new Id(payload.recurringExpenseId));
    if (!recurring) return Result.fail(notFound(payload.recurringExpenseId));
    const role = await this.groupMembers.roleOf(recurring.groupId.value, caller.data);
    if (!role) return Result.fail(notFound(payload.recurringExpenseId));

    const stopped = recurring.stop({
      by: caller.data,
      byOwner: role === 'owner',
      archived: await this.groupMembers.archivedOf(recurring.groupId.value),
    });
    if (stopped.isFailure()) return stopped;

    const removed = await this.recurringExpenses.remove(stopped.data);
    if (removed.isFailure()) return removed;

    await this.publishDomainEvents(stopped.data, context);
    return Result.ok(recurring._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Recurring expense not found', { id });
