import { IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** The store of expenses as aggregates: loads, saves and removes one. It never searches for a screen; that is IExpenseQueries. */
export interface IExpenseRepository {
  /** The expense with this id, or null when there is none. */
  findById(id: string): Promise<Expense | null>;
  /**
   * Stores an expense: a new one at version 1, or an edited one at the version it was read at plus one. An expense no
   * longer at the stored version, or a new one already stored, is refused with a ConcurrencyConflictException
   * (CONC-OPTIMISTIC). The balances it counts are stored with it, in the same transaction.
   */
  save(expense: Expense): Promise<IResult>;
  /**
   * Removes the expense from every read and from the balances, in the same transaction. An expense no longer at the
   * version it was read at, or no longer stored, is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  remove(expense: Expense): Promise<IResult>;
  /**
   * Moves the expense, with the balances it counts, to the group it now names, in the same transaction, at the version it was
   * read at: the version is kept, so an edit from the version its author read still applies (request 31). An expense no longer
   * stored at that version is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  move(expense: Expense): Promise<IResult>;
}
