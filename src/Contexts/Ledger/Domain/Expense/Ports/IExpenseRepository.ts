import { IResult } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/** The store of expenses: loads and saves whole aggregates, inside a transaction only (docs/adr/0004, docs/adr/0006). */
export interface IExpenseRepository {
  /** The expense as it is stored, at the version it is at; undefined when there is no such expense. */
  get(expenseId: string): Promise<Expense | undefined>;
  /**
   * Stores a new expense, or an edited one, if it is still at the version it was read at: a conflict otherwise
   * (ConcurrencyConflictException, CONC-OPTIMISTIC, docs/adr/0006).
   */
  save(expense: Expense): Promise<IResult<undefined>>;
  /** Removes the expense and its shares, if it is still at the version it was read at: a conflict otherwise. */
  remove(expense: Expense): Promise<IResult<undefined>>;
}
