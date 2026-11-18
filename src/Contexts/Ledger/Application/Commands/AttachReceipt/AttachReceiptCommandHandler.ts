import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt, ReceiptExpense } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptNotKeptException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';
import { readReceipt } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands/AttachReceipt/AttachReceiptCommandEvent';

/**
 * Attaching a receipt to an expense (request 26): a signed-in member attaches a JPEG or a PNG of at most 2 MB. The file is judged
 * first (its type from its first bytes, its size), then the expense is read through Ledger's read model and the receipt decides
 * whether the caller may attach it (the payer or the owner, no former member), all before anything is sent to the store. The
 * store's link is then taken and the receipt saved in place of the one the expense had, in one transaction with its event. A refusal
 * at any step changes nothing. To anyone who is not a member the expense does not exist. Its answer is the receipt's id.
 */
export class AttachReceiptCommandHandler extends CommandHandler<AttachReceiptCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private expenses: IExpenseQueries,
    private store: IReceiptStore,
    private receipts: IReceiptRepository,
  ) {
    super();
  }

  async execute(event: AttachReceiptCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const attacher = caller.data.value;

    const { expenseId, bytes } = event.payload;
    const file = readReceipt(bytes);
    if (file.isFailure()) return Result.fail(file.error);

    const expense = await this.expenses.findExpense(expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const members = await this.groupMembers.membersOf(expense.groupId, attacher);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    if (await this.groupMembers.isArchived(expense.groupId)) return Result.fail(new GroupArchivedException());

    const concerning: ReceiptExpense = {
      id: expense.id,
      groupId: expense.groupId,
      paidBy: expense.paidBy,
      memberIds: [expense.paidBy, ...expense.shares.map(share => share.memberId)],
    };
    const allowed = Receipt.mayAttach({ expense: concerning, members, attachedBy: attacher });
    if (allowed.isFailure()) return Result.fail(allowed.error);

    const kept = await this.store.keep(file.data);
    if (!kept) return Result.fail(new ReceiptNotKeptException());

    const current = await this.receipts.findByExpense(expenseId);
    const attached = Receipt.attach({
      expense: concerning,
      members,
      attachedBy: attacher,
      file: file.data,
      url: kept.url,
      current,
    });
    if (attached.isFailure()) return Result.fail(attached.error);

    const saved = await this.receipts.save(attached.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(attached.data, context);
    return Result.ok(attached.data._id.value);
  }
}
