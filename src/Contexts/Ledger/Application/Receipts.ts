import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';
import { decideAttachReceipt } from '@Contexts/Ledger/Domain/Receipt/Receipt.decision';
import { ReceiptNotKeptException } from '@Contexts/Ledger/Domain/Receipt/ReceiptExceptions';

import { IExpenseQueries } from './IExpenseQueries';
import { IGroupMembers, MemberOfGroup } from './IGroupMembers';
import { IReceiptQueries, ReceiptView } from './IReceiptQueries';
import { IReceiptRepository } from './IReceiptRepository';
import { IReceiptStore } from './IReceiptStore';

/**
 * The payer of an expense, or the group's owner, attaches a receipt to it (request 26): a JPEG or a PNG of at most 2 MB, its type read from its
 * first bytes. A receipt attached replaces the one the expense had, and the expense keeps its version. The file is sent to the receipts store only
 * once it is allowed; when the store does not keep it, the receipt is refused and nothing changes. Any other member is refused; anyone who is not a
 * member gets the answer for an expense that does not exist.
 */
export const attachReceipt = command(
  'AttachReceipt',
  (
    expenses: IExpenseQueries,
    groupMembers: IGroupMembers,
    receipts: IReceiptRepository,
    store: IReceiptStore,
    clock: Clock,
  ) =>
    async ({ id, bytes }: { id: string; bytes: Uint8Array }, context) => {
      return receipts.inTransaction(async () => {
        const by = callerOf(context);
        const expense = await expenses.expenseOf(id);
        if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
        const members = await groupMembers.membersOf(expense.groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));

        const decision = decideAttachReceipt(
          {
            expense,
            memberIds: memberIdsOf(members),
            ownerId: ownerIdOf(members),
            archived: await groupMembers.archivedOf(expense.groupId),
          },
          { by, bytes },
          clock(),
        );
        if (decision.isFailure()) return decision;
        const { type, size } = decision.data.state;

        const url = await store.keep({ type, bytes });
        if (url === undefined) return Result.fail(new ReceiptNotKeptException());

        const stored = await receipts.get(id);
        if (stored) {
          stored.attach({ type, size, url });
          await receipts.save(stored);
          await publishDomainEvents(stored, context);
        } else {
          const created = Receipt.attachFirst({ expenseId: id, type, size, url });
          await receipts.insert(created);
          await publishDomainEvents(created, context);
        }
        return Result.ok(undefined);
      });
    },
);

/**
 * A member of the expense's group reads its receipt: its type, its size in bytes and the link the store keeps it at (request 26). Anyone who is
 * not a member gets the answer for an expense that does not exist; an expense without a receipt has none to read.
 */
export const getReceipt = query(
  'GetReceipt',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers, receipts: IReceiptQueries) =>
    async ({ id }: { id: string }, context) => {
      const expense = await expenses.expenseOf(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      if (!(await groupMembers.membersOf(expense.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      }
      const receipt: ReceiptView | undefined = await receipts.receiptOf(id);
      if (!receipt) return Result.fail(new NotFoundException('Ledger', 'No receipt is found'));
      return Result.ok(receipt);
    },
);

const memberIdsOf = (members: MemberOfGroup[]): string[] => members.map(member => member.memberId);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';
