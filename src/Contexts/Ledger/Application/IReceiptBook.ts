import { Receipt, ReceiptType } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/** What a member reads of an expense's receipt (request 26): its type, its size in bytes and the link the store reads it at. */
export interface ReceiptView {
  readonly type: ReceiptType;
  readonly size: number;
  readonly url: string;
}

/**
 * The book of receipts (request 26, ADR 21), the port the use cases write and read through: one receipt per expense. `findByExpense` loads the
 * expense's receipt as the aggregate it was last saved as, or `undefined` when it has none; `add` keeps a new one, and `save` keeps a replaced one
 * only while it is still at the version it was loaded at, refusing it with a ConcurrencyConflictException otherwise (ADR 8); `viewOf` answers the
 * expense's receipt as a read model, or `undefined` when it has none.
 */
export interface IReceiptBook {
  findByExpense(expenseId: string): Promise<Receipt | undefined>;
  add(receipt: Receipt): Promise<void>;
  save(receipt: Receipt): Promise<void>;
  viewOf(expenseId: string): Promise<ReceiptView | undefined>;
}
