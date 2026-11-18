import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** An expense's receipt as a member of its group reads it: its type, its size in bytes, and the link the store reads it at. */
export interface ReceiptReadModel {
  type: ReceiptType;
  size: number;
  url: string;
}
