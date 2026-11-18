import { IResult } from '@Architecture/Domain';

import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/** The store of receipts as aggregates: loads and saves one. It never searches for a screen; that is IReceiptQueries. */
export interface IReceiptRepository {
  /** The receipt of an expense, or null when the expense has none. */
  findByExpense(expenseId: string): Promise<Receipt | null>;
  /**
   * Stores a receipt: a new one at version 1, or one that replaces the expense's receipt at the version it was read at plus one.
   * A new one whose expense already has a receipt stored, or a replacement no longer at the stored version, is refused with a
   * ConcurrencyConflictException (CONC-OPTIMISTIC). The expense itself is not touched: a receipt is not an edit.
   */
  save(receipt: Receipt): Promise<IResult>;
}
