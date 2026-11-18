import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/**
 * The expenses, as aggregates, written whole. An expense is loaded at the version it was stored at, and written only over
 * that version: a save or a removal over a newer one is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC,
 * feature 6). The balances move in the same transaction as the expense they count.
 */
export interface IExpenseRepository {
  /** The expense, as it is stored, if it is recorded. */
  get(id: string): Promise<Expense | undefined>;
  /**
   * Inserts a new expense with its shares, in one transaction. `recordedAt` is the instant it was recorded at, as ISO 8601 in UTC, from the
   * one clock (request 29): the statement puts it among the settlements of its day by it, and an edit never changes it.
   */
  insert(expense: Expense, recordedAt: string): Promise<void>;
  /** Writes an edited expense over the version it was read at, with its shares and balances, in one transaction. */
  save(expense: Expense): Promise<void>;
  /** Removes a deleted expense over the version it was read at, with its shares and balances, in one transaction. */
  remove(expense: Expense): Promise<void>;
  /**
   * Runs `work` in one transaction on the expenses' file: what it reads (a group's members, the expense) is read and written as one state,
   * so no other writer comes between its read and its write (ADR 17). A write inside it joins it.
   */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
