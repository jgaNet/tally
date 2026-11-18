import { IResult } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';

/** The store of budgets: loads and saves whole aggregates, inside a transaction only (docs/adr/0023). */
export interface IBudgets {
  /** The group's budget for the category as it is stored, at the version it is at; undefined when none was ever set for it. */
  get(groupId: string, category: Category): Promise<Budget | undefined>;
  /** Stores a new budget, or a changed one, if it is still at the version it was read at: a conflict otherwise (CONC-OPTIMISTIC). */
  save(budget: Budget): Promise<IResult<undefined>>;
}
