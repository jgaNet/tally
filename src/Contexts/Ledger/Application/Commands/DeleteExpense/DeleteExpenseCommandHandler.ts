import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { DeleteExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/DeleteExpense/DeleteExpenseCommandEvent';
import { IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';

/**
 * A member who paid an expense, or the owner of its group, removes it: it is gone from every read, and from every
 * balance, in the transaction that deletes it. An expense that concerns a member who has left cannot be removed. For
 * anyone not in the group the expense does not exist.
 */
export class DeleteExpenseCommandHandler extends CommandHandler<DeleteExpenseCommandEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
    private readonly audit: IAuditTrail,
  ) {
    super();
  }

  async execute({ payload }: DeleteExpenseCommandEvent, context: ExecutionContext): Promise<IResult<{ id: string }>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const now = this.clock();
    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const role = await this.groupMembers.roleOf(expense.groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const groupArchived = await this.groupMembers.isArchived(expense.groupId);

    const before = expense.toSnapshot();
    const deleted = expense.delete({
      by: caller.data,
      byOwner: role === 'owner',
      groupMembers: await this.groupMembers.currentMembers(expense.groupId),
      groupArchived,
      at: now,
    });
    if (deleted.isFailure()) return deleted;

    const saved = await this.expenses.save(deleted.data);
    if (saved.isFailure()) return saved;
    await this.audit.record({
      id: `expense-deleted:${before.id}:${before.version}`,
      groupId: before.groupId,
      at: now,
      by: caller.data.value,
      action: 'expense-deleted',
      subjectId: before.id,
      amount: before.amount,
    });
    await publishDomainEvents(deleted.data, context);
    return Result.ok({ id: deleted.data._id.value });
  }
}
