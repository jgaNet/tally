import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** What a receipt is, as the store keeps it: its row, read back (request 26). */
export interface ReceiptSnapshot {
  id: string;
  expenseId: string;
  groupId: string;
  type: ReceiptType;
  size: number;
  url: string;
  attachedBy: string;
  version: number;
}

/** A receipt as the query answers it: its type, its size in bytes and the store's link (request 26). */
export interface ReceiptView {
  type: ReceiptType;
  size: number;
  url: string;
}
