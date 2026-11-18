import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** What `GetReceipt` answers (request 26): the type and size of the file, and the link the store keeps it at. */
export interface ReceiptView {
  type: ReceiptType;
  size: number;
  url: string;
}

/** The read side of the receipts: a read model, never an aggregate (QUERY-READ-MODELS). */
export interface IReceiptQueries {
  /** The receipt of the expense, if it has one. Who may read it is the use case's to say. */
  receiptOf(expenseId: string): Promise<ReceiptView | undefined>;
}
