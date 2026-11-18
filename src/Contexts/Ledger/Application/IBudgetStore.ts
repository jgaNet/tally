import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A budget that is set, as a group's list shows it: its category and its amount. */
export interface BudgetLine {
  readonly category: Category;
  readonly amount: number;
}

/**
 * The store of budgets, the port the use cases and the judgement of a month write and read through. `findByCategory` loads a group's
 * budget for a category as the aggregate it was last saved as, or `undefined` when the group has none (removed ones included: their
 * passed months are kept); `add` keeps a new one, and `save` keeps one again, only while it is still at the version it was loaded at, and
 * refuses it with a ConcurrencyConflictException otherwise (ADR 8); `linesOf` answers a group's budgets that are set, in no particular order.
 */
export interface IBudgetStore {
  findByCategory(groupId: string, category: Category): Promise<Budget | undefined>;
  add(budget: Budget): Promise<void>;
  save(budget: Budget): Promise<void>;
  linesOf(groupId: string): Promise<BudgetLine[]>;
}
