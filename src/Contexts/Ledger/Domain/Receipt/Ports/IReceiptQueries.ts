import { ReceiptView } from '@Contexts/Ledger/Domain/Receipt/DTOs';

/** The read side of the receipts: what the query answers, read at once (request 26). */
export interface IReceiptQueries {
  /** The receipt of the expense, as the query answers it; undefined when the expense has none. */
  findByExpense(expenseId: string): Promise<ReceiptView | undefined>;
}
