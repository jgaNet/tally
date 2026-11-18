import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands/AttachReceipt/AttachReceiptCommandEvent';

/**
 * The payer of an expense, or the owner of its group, attaches a receipt to it, which replaces the one it had. The expense is
 * read as the read model has it, in this command's transaction, and so is the caller's role and the group's members now; the
 * Receipt decides whether the caller may (its rule is the expense's edit's), and the file is then read from its bytes and
 * refused before anything is sent to the store. The store answers the link, and the Receipt takes it. The expense keeps its
 * version: a receipt is not an edit.
 */
export class AttachReceiptCommandHandler extends CommandHandler<AttachReceiptCommandEvent> {
  constructor(
    private readonly receipts: IReceiptRepository,
    private readonly expenses: IExpenseQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly store: IReceiptStore,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: AttachReceiptCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const now = this.clock();
    const expense = await this.expenses.findById(payload.expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const groupId = new Id(expense.groupId);
    const role = await this.groupMembers.roleOf(groupId, caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const groupArchived = await this.groupMembers.isArchived(groupId);

    const expenseId = new Id(expense.id);
    const mayAttach = Receipt.mayBeAttachedBy({
      by: caller.data,
      byOwner: role === 'owner',
      payer: new Id(expense.paidBy),
      expenseMembers: expense.shares.map(share => new Id(share.memberId)),
      groupMembers: await this.groupMembers.currentMembers(groupId),
      groupArchived,
    });
    if (mayAttach.isFailure()) return mayAttach;

    const file = ReceiptFile.read(payload.bytes);
    if (file.isFailure()) return file;
    const stored = await this.store.keep(file.data);
    if (stored.isFailure()) return stored;

    const existing = await this.receipts.findByExpense(expenseId);
    const attached = existing
      ? existing.replaceWith({ file: file.data, stored: stored.data, groupArchived, at: now })
      : Receipt.attach({ expenseId, file: file.data, stored: stored.data, groupArchived, at: now });
    if (attached.isFailure()) return attached;

    const saved = await this.receipts.save(attached.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(attached.data, context);
    return Result.ok({ id: attached.data._id.value });
  }
}
