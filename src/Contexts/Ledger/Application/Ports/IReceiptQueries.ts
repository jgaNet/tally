import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';

export interface IReceiptQueries {
  /** The receipt of the expense, or null when it has none: whoever asks, the handler decides whether the caller may read it. */
  findByExpense(expenseId: string): Promise<ReceiptReadModel | null>;
}
