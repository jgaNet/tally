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
  /** The expenses of a group, as they are kept, for a merge of the group into another (request 31). */
  findInGroup(groupId: Id): Promise<Expense[]>;
  /** Stores an expense moved to another group, at the version it was read at: a move is not a change, so the version stays (request 31). */
  move(expense: Expense): Promise<IResult>;
}
