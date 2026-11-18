import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense/SetUpRecurringExpenseCommandEvent';

/**
 * Setting up a recurring expense: a signed-in member of a group sets up what they pay every month, split between members of the
 * group as an expense is (request 23). The payer is the caller; to anyone who is not a member the group does not exist. The
 * currency of the group is kept with it, the expenses it records are in it. Saved, and what it recorded published, in one
 * transaction. Its answer is its id.
 */
export class SetUpRecurringExpenseCommandHandler extends CommandHandler<SetUpRecurringExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private recurring: IRecurringExpenseRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: SetUpRecurringExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payer = caller.data.value;

    const { groupId, description, amount, startsOn, split, category } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, payer);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (await this.groupMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    // A suspended account sets up no recurring expense, in any group (request 34).
    if (await this.groupMembers.isSuspended(payer)) return Result.fail(new AccountSuspendedException());
    const currency = await this.groupCurrency.currencyOf(groupId, payer);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const set = RecurringExpense.setUp({
      groupId,
      paidBy: payer,
      currency,
      description,
      amount,
      startsOn,
      split,
      memberIds: members.map(member => member.memberId),
      today: this.clock(),
      category,
    });
    if (set.isFailure()) return Result.fail(set.error);

    const saved = await this.recurring.save(set.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(set.data, context);
    return Result.ok(set.data._id.value);
  }
}
