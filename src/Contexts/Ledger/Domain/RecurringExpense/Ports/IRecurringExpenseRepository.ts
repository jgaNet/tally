import { IResult } from '@Architecture/Domain';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/** The store of recurring expenses as aggregates: loads, saves and removes one. It never searches for a screen; that is IRecurringExpenseQueries. */
export interface IRecurringExpenseRepository {
  /** The recurring expense with this id, or null when there is none. */
  findById(id: string): Promise<RecurringExpense | null>;
  /** The recurring expenses whose next day has come by `at`, the ones the background job decides, the earliest set up first. */
  dueBy(at: Date): Promise<RecurringExpense[]>;
  /**
   * Stores a new recurring expense at version 1, or one whose next day moved on, at the version it was read at plus one. One no
   * longer at the stored version, or a new one already stored, is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  save(recurring: RecurringExpense): Promise<IResult>;
  /** Removes the recurring expense at the version it was read at; one no longer at that version, or no longer stored, is refused with a ConcurrencyConflictException. */
  remove(recurring: RecurringExpense): Promise<IResult>;
}
