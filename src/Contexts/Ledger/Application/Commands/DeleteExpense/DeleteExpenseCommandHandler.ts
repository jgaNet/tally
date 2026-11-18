import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { DeleteExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/DeleteExpense/DeleteExpenseCommandEvent';

/**
 * Deleting an expense: a signed-in member who is its payer or the group's owner removes it, so that it is read by no one
 * and counts in no balance. To anyone who is not a member of its group the expense does not exist. The removal is saved
 * and what it recorded is published with it, in one transaction. Its answer is the expense's id.
 */
export class DeleteExpenseCommandHandler extends CommandHandler<DeleteExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private expenses: IExpenseRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: DeleteExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const deleter = caller.data.value;

    const { expenseId } = event.payload;
    const expense = await this.expenses.findById(expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const members = await this.groupMembers.membersOf(expense.groupId, deleter);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    if (await this.groupMembers.isArchived(expense.groupId)) return Result.fail(new GroupArchivedException());

    const deleted = expense.delete({ deletedBy: deleter, members, at: this.clock() });
    if (deleted.isFailure()) return Result.fail(deleted.error);

    const removed = await this.expenses.remove(expense);
    if (removed.isFailure()) return Result.fail(removed.error);

    await this.publishDomainEvents(expense, context);
    return Result.ok(expenseId);
  }
}
