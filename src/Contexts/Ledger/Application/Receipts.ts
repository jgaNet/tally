import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ReceiptView } from '@Contexts/Ledger/Domain/Receipt/DTOs';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { IReceipts } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceipts';
import { IReceiptQueries } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';

/** What a member asks to attach: the expense, and the file as it was sent (request 26). */
export interface AttachReceiptInput {
  expenseId: string;
  bytes: Uint8Array;
}

/**
 * Attaches a receipt to an expense, for its payer or the group's owner (request 26, docs/adr/0025). For anyone outside its group the expense
 * does not exist; any other member is refused `403`. The file is checked before anything is sent to the store: a file that is not a JPEG or a
 * PNG of at most 2 MB is refused, and nothing is sent. The store's link is kept; a receipt the expense had is replaced, and the expense keeps
 * its version.
 */
export const attachReceipt = command(
  'AttachReceipt',
  (receipts: IReceipts, store: IReceiptStore, expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ expenseId, bytes }: AttachReceiptInput, context) => {
      const by = callerOf(context);
      const expense = await expenses.findExpense(expenseId);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(by, expense.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));

      const checked = Receipt.check({ by, members, paidBy: expense.paidBy, bytes });
      if (checked.isFailure()) return checked;
      const kept = await store.keep({ bytes, type: checked.data.type });
      if (kept.isFailure()) return kept;

      const stored = await receipts.findByExpense(expenseId);
      const receipt = stored
        ? stored.reattach({ by, members, paidBy: expense.paidBy, bytes, url: kept.data })
        : Receipt.attach({
            expenseId,
            groupId: expense.groupId,
            by,
            members,
            paidBy: expense.paidBy,
            bytes,
            url: kept.data,
          });
      if (receipt.isFailure()) return receipt;

      const saved = await receipts.save(receipt.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(receipt.data, context);
      return Result.ok(undefined);
    },
);

/**
 * The receipt of an expense, for the members of its group (request 26): its type, its size in bytes and the store's link. For anyone else
 * the expense does not exist; an expense without a receipt has none to read (`404`).
 */
export const getReceipt = query(
  'GetReceipt',
  (receipts: IReceiptQueries, expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ expenseId }: { expenseId: string }, context) => {
      const expense = await expenses.findExpense(expenseId);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const members = await groupMembers.membersOf(callerOf(context), expense.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such expense'));
      const receipt: ReceiptView | undefined = await receipts.findByExpense(expenseId);
      if (!receipt) return Result.fail(new NotFoundException('Ledger', 'The expense has no receipt'));
      return Result.ok(receipt);
    },
);
