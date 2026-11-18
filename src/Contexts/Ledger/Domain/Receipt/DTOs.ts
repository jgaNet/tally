import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** A receipt as it is stored: its id, its expense and group, its file's type and size, the link the store kept it at, who attached it, and its version. */
export interface IReceiptSnapshot {
  _id: string;
  expenseId: string;
  groupId: string;
  type: ReceiptType;
  size: number;
  url: string;
  attachedBy: string;
  version: number;
}
