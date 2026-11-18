import { DomainEvent } from '@Architecture/Domain';

import { ReceiptType } from './ReceiptFile';

/** A receipt was attached to an expense, new or in place of the one it had (request 26). Recorded by `Receipt.attachFirst` and `Receipt.attach`. */
export class ReceiptAttachedEvent extends DomainEvent<{
  receiptId: string;
  expenseId: string;
  type: ReceiptType;
  size: number;
}> {}
