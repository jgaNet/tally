import { DomainEvent } from '@Architecture/Domain';

/** A receipt was attached to an expense by a member who may change it (request 26). Recorded by `Receipt.attach()` and `reattach()`. */
export class ReceiptAttachedEvent extends DomainEvent<{
  receiptId: string;
  expenseId: string;
  groupId: string;
  attachedBy: string;
}> {}
