import { Id, IResult } from '@Architecture/Domain';

import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

export interface IReceiptRepository {
  /** The receipt the expense has, or null: one per expense. */
  findByExpense(expenseId: Id): Promise<Receipt | null>;
  /**
   * Stores a new receipt, or one replaced at its version + 1. It runs in the command's transaction; a receipt at another version than it was
   * read at, or a second receipt for an expense, is a ConcurrencyConflict.
   */
  save(receipt: Receipt): Promise<IResult>;
}
