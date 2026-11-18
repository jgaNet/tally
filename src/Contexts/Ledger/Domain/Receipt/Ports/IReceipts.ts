import { IResult } from '@Architecture/Domain';

import { Receipt } from '@Contexts/Ledger/Domain/Receipt/Receipt';

/**
 * The store of receipts: loads and saves whole aggregates inside a transaction only (request 26, docs/adr/0025). One receipt per expense:
 * `findByExpense()` is the receipt the expense has, if any.
 */
export interface IReceipts {
  /** The receipt of the expense, as it is stored, at the version it is at; undefined when the expense has none. */
  findByExpense(expenseId: string): Promise<Receipt | undefined>;
  /** Stores a new receipt, or a replaced one, if it is still at the version it was read at: a conflict otherwise (CONC-OPTIMISTIC). */
  save(receipt: Receipt): Promise<IResult<undefined>>;
}
