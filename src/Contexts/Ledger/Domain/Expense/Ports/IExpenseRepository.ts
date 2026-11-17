import { Id, IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

export interface IExpenseRepository {
  /** The expense under this id, or null. */
  findById(id: Id): Promise<Expense | null>;
  /**
   * Stores a new expense under the id it was born with, or a changed one at its version + 1. It runs in the command's
   * transaction; an expense at another version than it was read at is a ConcurrencyConflict.
   */
  save(expense: Expense): Promise<IResult>;
  /** Removes the expense and its shares, if it is still at the version it was read at (else a ConcurrencyConflict). */
  delete(expense: Expense): Promise<IResult>;
}
