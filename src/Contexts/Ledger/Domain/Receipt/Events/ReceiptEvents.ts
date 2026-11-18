import { DomainEvent } from '@Architecture/Domain';

/** A receipt was attached to an expense, or replaced the one it had: its type and its size; the file itself is in the store. */
export class ReceiptAttachedEvent extends DomainEvent<{
  receiptId: string;
  expenseId: string;
  type: string;
  size: number;
  attachedAt: string;
}> {}
