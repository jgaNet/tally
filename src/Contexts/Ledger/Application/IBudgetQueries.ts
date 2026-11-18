import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

/** A category's budget and what the month spends in it, as `GetGroupBudgets` answers it (request 24). */
export interface BudgetView {
  category: ExpenseCategory;
  amount: number;
  spent: number;
}

/** The read side of the budgets: read models, never aggregates (QUERY-READ-MODELS). */
export interface IBudgetQueries {
  /** The budgets the group has now (a removed one is not one), as category and amount, in no order. */
  budgetsOf(groupId: string): Promise<{ category: ExpenseCategory; amount: number }[]>;
}
