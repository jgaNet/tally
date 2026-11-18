import { IResult } from '@Architecture/Domain';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** The store of budgets as aggregates: loads and saves one. It never searches for a screen; that is IBudgetQueries. */
export interface IBudgetRepository {
  /** The budget of a category of a group, or null when none was ever set for it. */
  findFor(groupId: string, category: Category): Promise<Budget | null>;
  /**
   * Stores a budget: a new one at version 1, or one changed at the version it was read at plus one. A budget no longer at the
   * stored version, or a new one whose category already has one stored, is refused with a ConcurrencyConflictException
   * (CONC-OPTIMISTIC). The months it passed are stored with it, in the same transaction.
   */
  save(budget: Budget): Promise<IResult>;
}
