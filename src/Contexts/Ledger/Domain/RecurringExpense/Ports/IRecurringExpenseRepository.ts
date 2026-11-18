import { Id, IResult } from '@Architecture/Domain';

import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

export interface IRecurringExpenseRepository {
  /** The recurring expense under this id, or null. */
  findById(id: Id): Promise<RecurringExpense | null>;
  /**
   * The ids of the recurring expenses whose day has come by `today` (a UTC day, YYYY-MM-DD), in the order they were set up. Read
   * by the sweep outside any transaction; each one is then decided in a transaction of its own.
   */
  findDueIds(today: string): Promise<Id[]>;
  /** Stores a new recurring expense, or one changed at its version + 1; a version it was not read at is a ConcurrencyConflict. */
  save(recurring: RecurringExpense): Promise<IResult>;
  /** Removes the recurring expense, if it is still at the version it was read at (else a ConcurrencyConflict). */
  remove(recurring: RecurringExpense): Promise<IResult>;
  /** The recurring expenses of a group, for a merge of the group into another (request 31). */
  findInGroup(groupId: Id): Promise<RecurringExpense[]>;
  /** Stores a recurring expense moved to another group, at the version it was read at (request 31). */
  move(recurring: RecurringExpense): Promise<IResult>;
}
