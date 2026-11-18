import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense/StopRecurringExpenseCommandEvent';

/**
 * Stopping a recurring expense: its payer or the group's owner stops it, and it no longer exists, so that no expense is recorded
 * for it from then on; the expenses it recorded stay (request 23). To anyone who is not a member of its group it does not exist.
 * Removed and what it recorded published in one transaction. Its answer is its id.
 */
export class StopRecurringExpenseCommandHandler extends CommandHandler<StopRecurringExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private recurring: IRecurringExpenseRepository,
  ) {
    super();
  }

  async execute(event: StopRecurringExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const stopper = caller.data.value;

    const { recurringId } = event.payload;
    const recurring = await this.recurring.findById(recurringId);
    if (!recurring) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
    const members = await this.groupMembers.membersOf(recurring.groupId, stopper);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
    if (await this.groupMembers.isArchived(recurring.groupId)) return Result.fail(new GroupArchivedException());

    const stopped = recurring.stop({ stoppedBy: stopper, members });
    if (stopped.isFailure()) return Result.fail(stopped.error);

    const removed = await this.recurring.remove(recurring);
    if (removed.isFailure()) return Result.fail(removed.error);

    await this.publishDomainEvents(recurring, context);
    return Result.ok(recurringId);
  }
}
