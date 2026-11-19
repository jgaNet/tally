import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/**
 * The recurring expenses, as aggregates, written whole. One is loaded at the version it was stored at, and written only over that
 * version: a save or a removal over a newer one is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC, request 23).
 */
export interface IRecurringExpenseRepository {
  /** The recurring expense, as it is stored, if it is set up. */
  get(id: string): Promise<RecurringExpense | undefined>;
  /** Every recurring expense, in the order they were set up. */
  all(): Promise<RecurringExpense[]>;
  /** Inserts a new recurring expense. */
  insert(recurring: RecurringExpense): Promise<void>;
  /** Writes a recurring expense whose days moved on over the version it was read at. */
  save(recurring: RecurringExpense): Promise<void>;
  /** The recurring expenses of a group, as they are stored, in the order they were set up (request 31, the move of a merged group). */
  ofGroup(groupId: string): Promise<RecurringExpense[]>;
  /** Writes a recurring expense moved to another group over the version it was read at, the version kept (request 31). */
  saveMoved(recurring: RecurringExpense): Promise<void>;
  /** Removes a recurring expense over the version it was read at: stopped, or ended. */
  remove(recurring: RecurringExpense): Promise<void>;
  /** Runs `work` in one transaction on the store, so what it reads and writes is one state (ADR 17). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
