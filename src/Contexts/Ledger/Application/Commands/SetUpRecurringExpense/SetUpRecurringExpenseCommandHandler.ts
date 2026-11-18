import { CommandHandler, Clock, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SetUpRecurringExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense/SetUpRecurringExpenseCommandEvent';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';

/**
 * A signed-in member of a group sets up a recurring expense they pay: the payer is the caller, and the operation answers its id.
 * For anyone who is not a member the group does not exist, as for an expense. The members are read from Groups through the port
 * Ledger owns (ADR 3); the recurring expense decides its start day and its split, under the rules of an expense.
 */
export class SetUpRecurringExpenseCommandHandler extends CommandHandler<SetUpRecurringExpenseCommandEvent> {
  constructor(
    private recurringExpenses: IRecurringExpenseRepository,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SetUpRecurringExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const members = await this.groupMembers.membersOf(payload.groupId);
    if (!members.some(member => member.value === caller.data.value)) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));
    }

    const recurring = RecurringExpense.setUp({
      groupId: new Id(payload.groupId),
      paidBy: caller.data,
      description: payload.description,
      amount: payload.amount,
      startsOn: payload.startsOn,
      split: payload.split,
      category: payload.category,
      groupMembers: members,
      archived: await this.groupMembers.archivedOf(payload.groupId),
      suspended: await this.groupMembers.suspendedOf(caller.data),
      now: this.clock(),
    });
    if (recurring.isFailure()) return recurring;

    const saved = await this.recurringExpenses.save(recurring.data);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(recurring.data, context);
    return Result.ok(recurring.data._id.value);
  }
}
