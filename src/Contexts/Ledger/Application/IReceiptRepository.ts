import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * The receipts, as aggregates, one per expense, written whole. A receipt is loaded at the version it was stored at, and written only over that
 * version: a save over a newer one is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export interface IReceiptRepository {
  /** The receipt of the expense, as it is stored, if it has one. */
  get(expenseId: string): Promise<Receipt | undefined>;
  /** Inserts the first receipt of an expense. */
  insert(receipt: Receipt): Promise<void>;
  /** Writes a receipt attached again, over the version it was read at. */
  save(receipt: Receipt): Promise<void>;
  /** Runs `work` in one transaction on the store, so what it reads and writes is one state (ADR 17). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
