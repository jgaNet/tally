import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** What a member reads of a budget: its category, its amount, and what the month asked spends in the category. */
export interface BudgetView {
  category: Category;
  amount: number;
  spent: number;
}

/** The read side of budgets: a read model, never an aggregate (QUERY-READ-MODELS). Membership is not asked here. */
export interface IBudgetQueries {
  /**
   * The categories of a group that have a budget, in the order of the categories (request 24), each with what the expenses of
   * the category dated in `month` (YYYY-MM) spend.
   */
  listGroupBudgets(groupId: string, month: string): Promise<BudgetView[]>;
  /** What the group's expenses of a category, dated in `month` (YYYY-MM, in UTC), spend in total; deleted ones left out. */
  spentIn(groupId: string, category: Category, month: string): Promise<number>;
}
