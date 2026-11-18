import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IReceiptBook, ReceiptView } from '@Contexts/Ledger/Application/IReceiptBook';
import { IReceiptStore } from '@Contexts/Ledger/Application/IReceiptStore';
import {
  ExpenseNotFoundException,
  NotThePayerOrOwnerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Receipt, examineReceipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { ReceiptNotFoundException, ReceiptNotKeptException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

/** What a member attaches to an expense: the expense, and the file as it was sent (request 26). */
export interface AttachReceiptInput {
  readonly expenseId: string;
  readonly bytes: Uint8Array;
}

/**
 * Attaches a receipt to an expense (request 26): the file of an expense's payer or of the group's owner, a JPEG or a PNG of 1 byte to 2 MB, its
 * type read from its first bytes. A caller who is not a member of the expense's group gets the expense's `404`; another member who is neither the
 * payer nor the owner gets `403`. A file refused is never sent to the store; a store that keeps nothing refuses the receipt (`422`), and nothing
 * changes. A receipt the expense already has is replaced by the new one, which keeps the expense's version (the expense is not edited). What it
 * recorded (ReceiptAttached) goes out with the commit, through the outbox.
 */
export const attachReceipt = command(
  'AttachReceipt',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, receipts: IReceiptBook, store: IReceiptStore, clock: Clock) =>
    async ({ expenseId, bytes }: AttachReceiptInput, context): Promise<IResult<void>> => {
      const allowed = await mayAttach(expenses, groupMembers, expenseId, context);
      if (allowed.isFailure()) return Result.fail(allowed.error);

      const file = examineReceipt(bytes);
      if (file.isFailure()) return Result.fail(file.error);

      const kept = await store.keep({ type: file.data.type, bytes });
      if (!kept) return Result.fail(new ReceiptNotKeptException());

      const current = await receipts.findByExpense(expenseId);
      if (current) {
        current.reattach({ fileId: kept.id, url: kept.url, file: file.data }, clock());
        await receipts.save(current);
        await publishDomainEvents(current, context);
      } else {
        const attached = Receipt.attach({ expenseId, fileId: kept.id, url: kept.url, file: file.data }, clock());
        await receipts.add(attached);
        await publishDomainEvents(attached, context);
      }
      return Result.ok(undefined);
    },
);

/**
 * An expense's receipt as a member of its group reads it (request 26): its type, its size in bytes and the store's link. To anyone who is not a
 * member, the expense does not exist (`404`); an expense with no receipt has none to read (`404`).
 */
export const getReceipt = query(
  'GetReceipt',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, receipts: IReceiptBook) =>
    async (expenseId: string, context): Promise<IResult<ReceiptView>> => {
      const expense = await expenses.viewOf(expenseId);
      if (!expense) return Result.fail(new ExpenseNotFoundException());
      const members = await groupMembers.membersOf(expense.groupId);
      if (!members || !members.some(member => member.memberId === callerOf(context))) {
        return Result.fail(new ExpenseNotFoundException());
      }
      const view = await receipts.viewOf(expenseId);
      if (!view) return Result.fail(new ReceiptNotFoundException());
      return Result.ok(view);
    },
);

/**
 * Whether the caller may attach a receipt to the expense, by the expense's rules (the same as an edit's, request 6): it is there for a member of
 * its group (else the expense's `404`), and the caller paid it or is the group's owner (else `403`).
 */
async function mayAttach(
  expenses: IExpenseStore,
  groupMembers: IGroupMembers,
  expenseId: string,
  context: ExecutionContext,
): Promise<IResult<void>> {
  const expense = await expenses.viewOf(expenseId);
  if (!expense) return Result.fail(new ExpenseNotFoundException());
  const members = await groupMembers.membersOf(expense.groupId);
  const caller = callerOf(context);
  const me = members?.find(member => member.memberId === caller);
  if (!members || !me) return Result.fail(new ExpenseNotFoundException());
  if (expense.paidBy !== caller && me.role !== 'owner') return Result.fail(new NotThePayerOrOwnerException());
  return Result.ok(undefined);
}
