import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { DeleteExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/DeleteExpense/DeleteExpenseCommandEvent';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of an expense's group deletes it: its payer or the group's owner may. For anyone who is not a member the
 * expense does not exist. The expense and its shares are removed, and the balances forget them, in this same transaction.
 */
export class DeleteExpenseCommandHandler extends CommandHandler<DeleteExpenseCommandEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupMembers: IGroupMembers,
    private balances: IBalanceCounts,
  ) {
    super();
  }

  async execute({ payload }: DeleteExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.fail(notFound(payload.expenseId));
    const role = await this.groupMembers.roleOf(expense.groupId.value, caller.data);
    if (!role) return Result.fail(notFound(payload.expenseId));

    const deleted = expense.delete({
      by: caller.data,
      byOwner: role === 'owner',
      archived: await this.groupMembers.archivedOf(expense.groupId.value),
      groupMembers: await this.groupMembers.membersOf(expense.groupId.value),
    });
    if (deleted.isFailure()) return deleted;

    const removed = await this.expenses.delete(deleted.data);
    if (removed.isFailure()) return removed;
    await this.balances.uncount(expense);

    await this.publishDomainEvents(deleted.data, context);
    return Result.ok(expense._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Expense not found', { id });
