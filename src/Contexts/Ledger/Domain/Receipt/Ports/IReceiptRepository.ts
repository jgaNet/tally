import { Id, IResult } from '@Architecture/Domain';
import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/** The receipts, one per expense. It answers the receipt of an expense, or null when it has none. */
export interface IReceiptRepository {
  /** The receipt of this expense as it was read (its version), or null when the expense has none. */
  findByExpense(expenseId: Id): Promise<Receipt | null>;
  /**
   * Stores the receipt: a new one at version 0 is inserted, one with a version is stored at version + 1. Refused with a
   * ConcurrencyConflictException when it is no longer at the stored version, or when the expense got a receipt meanwhile.
   */
  save(receipt: Receipt): Promise<IResult>;
}
