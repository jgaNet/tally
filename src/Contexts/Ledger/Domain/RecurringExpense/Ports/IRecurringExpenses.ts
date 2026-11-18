import { IResult } from '@Architecture/Domain';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/** The store of recurring expenses: loads and saves whole aggregates, inside a transaction only (docs/adr/0022). */
export interface IRecurringExpenses {
  /** The recurring expense as it is stored, at the version it is at; undefined when there is no such one. */
  get(recurringId: string): Promise<RecurringExpense | undefined>;
  /** Stores a new recurring expense, or one moved on, if it is still at the version it was read at: a conflict otherwise. */
  save(recurring: RecurringExpense): Promise<IResult<undefined>>;
  /** Deletes it, if it is still at the version it was read at: a conflict otherwise. */
  delete(recurring: RecurringExpense): Promise<IResult<undefined>>;
}
