import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

/**
 * The budgets, as aggregates, one per group and category, written whole. A budget is loaded at the version it was stored at, and
 * written only over that version: a save over a newer one is refused with a ConcurrencyConflictException (CONC-OPTIMISTIC). A budget
 * that was removed is still stored, with no amount and the months it was passed in, so that a month is passed once.
 */
export interface IBudgetRepository {
  /** The budget of the category of the group, as it is stored, removed or not, if one was ever set. */
  get(groupId: string, category: ExpenseCategory): Promise<Budget | undefined>;
  /** Inserts the first budget of a category of a group. */
  insert(budget: Budget): Promise<void>;
  /** Writes a budget set again, removed, or passed in a month, over the version it was read at, with the months it was passed in. */
  save(budget: Budget): Promise<void>;
  /** Runs `work` in one transaction on the store, so what it reads and writes is one state (ADR 17). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
