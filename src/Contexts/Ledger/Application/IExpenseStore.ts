import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Share } from '@Contexts/Ledger/Domain/Expense/Split';

/** What a screen shows of one expense: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface ExpenseView {
  readonly id: string;
  readonly groupId: string;
  readonly description: string;
  readonly amount: number;
  readonly date: string;
  readonly paidBy: string;
  readonly shares: readonly Share[];
}

/**
 * The store of expenses, the port the use cases write and read through. `add` keeps a new expense with its shares, in the
 * transaction of the command; `viewOf` answers an expense as a read model, or `undefined` when there is none. Nothing
 * changes an expense once it is kept, so the store has no `save`.
 */
export interface IExpenseStore {
  add(expense: Expense): Promise<void>;
  viewOf(expenseId: string): Promise<ExpenseView | undefined>;
}
