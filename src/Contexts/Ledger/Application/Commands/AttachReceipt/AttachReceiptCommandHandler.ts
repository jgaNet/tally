import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { AttachReceiptCommandEvent } from '@Contexts/Ledger/Application/Commands/AttachReceipt/AttachReceiptCommandEvent';
import { IExpenseFacts } from '@Contexts/Ledger/Application/Ports/IExpenseFacts';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IReceiptRepository } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptRepository';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptFile } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';
import { ReceiptNotStored } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/**
 * A signed-in member of an expense's group attaches a receipt to it: the expense's payer or the group's owner may, and for anyone who is not
 * a member the expense does not exist. The file is read (a JPEG or a PNG of 1 byte to 2 MB) and the rule is asked before the store is sent
 * anything; the store's link is then kept with the receipt, which replaces the one the expense had. The expense itself is not changed. The
 * operation answers the receipt's id.
 */
export class AttachReceiptCommandHandler extends CommandHandler<AttachReceiptCommandEvent> {
  constructor(
    private expenses: IExpenseFacts,
    private receipts: IReceiptRepository,
    private store: IReceiptStore,
    private groupMembers: IGroupMembers,
  ) {
    super();
  }

  async execute({ payload }: AttachReceiptCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.expenses.expenseOf(payload.expenseId);
    if (!expense) return Result.fail(notFound(payload.expenseId));
    const role = await this.groupMembers.roleOf(expense.groupId, caller.data);
    if (!role) return Result.fail(notFound(payload.expenseId));

    const file = ReceiptFile.inspect(payload.bytes);
    if (file.isFailure()) return file;

    const decision = {
      expense: {
        id: new Id(expense.id),
        groupId: new Id(expense.groupId),
        paidBy: new Id(expense.paidBy),
        involved: [expense.paidBy, ...expense.shares.map(share => share.memberId)].map(id => new Id(id)),
      },
      by: caller.data,
      byOwner: role === 'owner',
      archived: await this.groupMembers.archivedOf(expense.groupId),
      groupMembers: await this.groupMembers.membersOf(expense.groupId),
      file: file.data,
    };
    const allowed = Receipt.attachable(decision);
    if (allowed.isFailure()) return allowed;

    const stored = await this.store.keep({ bytes: payload.bytes, type: file.data.type });
    if (!stored) return Result.fail(new ReceiptNotStored());

    const existing = await this.receipts.findByExpense(new Id(expense.id));
    const attached = existing ? existing.supersede({ ...decision, stored }) : Receipt.attach({ ...decision, stored });
    if (attached.isFailure()) return attached;

    const saved = await this.receipts.save(attached.data);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(attached.data, context);
    return Result.ok(attached.data._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Expense not found', { id });
