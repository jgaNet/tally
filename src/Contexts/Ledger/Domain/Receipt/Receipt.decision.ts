import { NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { concernsFormerMember, mayChange } from '@Contexts/Ledger/Domain/Expense/Expense.decision';
import { ExpenseHasFormerMemberException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';

import { readReceiptFile, ReceiptType } from './ReceiptFile';

/** What attaching a receipt says: the caller, and the file's bytes as they were sent. */
export interface AttachReceiptCommand {
  by: string;
  bytes: Uint8Array;
}

/**
 * What an attachment is decided against: the expense as it is read (its payer and the members of its split), the members of its group, and
 * its owner. The use case read them from Ledger's own read model and from Groups before it decided; the caller is a member.
 */
export interface AttachReceiptAccess {
  expense: Pick<ExpenseSnapshot, 'paidBy' | 'shares'>;
  memberIds: readonly string[];
  ownerId: string;
}

/** The file's type and size, once it is allowed: what the receipt keeps, besides the link the store answers. */
export interface ReceiptFileValues {
  type: ReceiptType;
  size: number;
}

/** The message of a refusal to attach a receipt by someone who is neither the expense's payer nor the group's owner. */
const MAY_NOT_ATTACH = "Only the expense's payer or the group's owner may attach its receipt";

/**
 * Attaching a receipt to an expense, as request 26 decides it: only the expense's payer or the group's owner may, under the Expense's own rules
 * (`mayChange`, and no former member of the group among its payer or its split, ADR 23). The file is then read from its first bytes: a JPEG or a
 * PNG of 1 byte to 2 MB, or it is refused. It answers the type and size the receipt keeps; the use case sends the file to the store only after this
 * answers, so a refused file is never sent, and keeps the link the store answers.
 */
export const decideAttachReceipt: Decision<ReceiptFileValues, AttachReceiptCommand, never, AttachReceiptAccess> = (
  { expense, memberIds, ownerId },
  { by, bytes },
) => {
  if (!mayChange(expense.paidBy, ownerId, by)) return Result.fail(new NotAllowedException('Ledger', MAY_NOT_ATTACH));
  if (concernsFormerMember(expense, memberIds)) return Result.fail(new ExpenseHasFormerMemberException());
  const file = readReceiptFile(bytes);
  if (file.isFailure()) return file;
  return decided(file.data);
};
