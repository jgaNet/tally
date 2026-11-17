import { IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** The store of expenses as aggregates: loads and saves one. It never searches for a screen; that is IExpenseQueries. */
export interface IExpenseRepository {
  /** The expense with this id, or null when there is none. */
  findById(id: string): Promise<Expense | null>;
  /**
   * Stores a new expense at version 1. An expense already stored is refused with a ConcurrencyConflictException: an
   * expense changes nothing once recorded (CONC-OPTIMISTIC).
   */
  save(expense: Expense): Promise<IResult>;
}
