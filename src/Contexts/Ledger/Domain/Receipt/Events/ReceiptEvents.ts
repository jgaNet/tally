import { DomainEvent } from '@Architecture/Domain';

/** A receipt was attached to an expense, or replaced the one it had: the receipt, its expense and the expense's group. */
export class ReceiptAttachedEvent extends DomainEvent<{ receiptId: string; expenseId: string; groupId: string }> {}
