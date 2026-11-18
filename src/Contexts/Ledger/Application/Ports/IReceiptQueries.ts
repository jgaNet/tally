import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';

export interface IReceiptQueries {
  /** The receipt of this expense as a member reads it, or null when the expense has none. */
  findByExpense(expenseId: string): Promise<ReceiptReadModel | null>;
}
