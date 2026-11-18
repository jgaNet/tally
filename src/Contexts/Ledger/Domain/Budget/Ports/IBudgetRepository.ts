import { Id, IResult } from '@Architecture/Domain';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

export interface IBudgetRepository {
  /** The budget of the group for the category, set or since removed, or null when none was ever set. */
  findByGroupAndCategory(groupId: Id, category: CategoryName): Promise<Budget | null>;
  /** Stores a new budget, or a changed one at its version + 1; a version it was not read at is a ConcurrencyConflict. */
  save(budget: Budget): Promise<IResult>;
}
