import { ReceiptType } from '@Contexts/Ledger/Domain/Receipt/ReceiptFile';

/** What a member reads of a receipt: its type, its size in bytes, and the link the store keeps it at (request 26). */
export interface ReceiptView {
  type: ReceiptType;
  size: number;
  url: string;
}

/** The read side of receipts: a read model, never an aggregate (QUERY-READ-MODELS). Membership is not asked here. */
export interface IReceiptQueries {
  /** The receipt of an expense, or null when the expense has none. */
  findByExpense(expenseId: string): Promise<ReceiptView | null>;
}
