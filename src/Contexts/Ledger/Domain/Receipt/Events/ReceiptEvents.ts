import { DomainEvent } from '@Architecture/Domain';

import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/**
 * A receipt was attached to an expense, replacing the one it had: the receipt's id, the expense, the group, the type and size
 * of the file, and who attached it (request 26). A domain event: no other context reads a receipt, so no integration event says it.
 */
export class ReceiptAttachedEvent extends DomainEvent<{
  receiptId: string;
  expenseId: string;
  groupId: string;
  type: ReceiptType;
  size: number;
  attachedBy: string;
}> {}
