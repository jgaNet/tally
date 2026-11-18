import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { StopRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/StopRecurringExpense/StopRecurringExpenseCommandEvent';

/**
 * The payer of a recurring expense, or the owner of its group, stops it: it no longer exists, and no expense is recorded for
 * it from then on; the expenses it recorded stay. For anyone not in the group it does not exist.
 */
export class StopRecurringExpenseCommandHandler extends CommandHandler<StopRecurringExpenseCommandEvent> {
  constructor(
    private readonly recurring: IRecurringExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(
    { payload }: StopRecurringExpenseCommandEvent,
    context: ExecutionContext,
  ): Promise<IResult<{ id: string }>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const now = this.clock();
    const found = await this.recurring.findById(new Id(payload.recurringId));
    if (!found) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));
    const role = await this.groupMembers.roleOf(found.groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Recurring expense not found'));

    const stopped = found.stop({ by: caller.data, byOwner: role === 'owner', at: now });
    if (stopped.isFailure()) return stopped;

    const saved = await this.recurring.save(stopped.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(stopped.data, context);
    return Result.ok({ id: stopped.data._id.value });
  }
}
