import { BudgetView } from '@Contexts/Ledger/Domain/Budget/DTOs';

/** The read side of the budgets: what the queries answer, read at once (request 24). */
export interface IBudgetQueries {
  /**
   * Each category of the group that has a budget, in the order of the categories, with its amount and what the given month spends in
   * the category (`YYYY-MM`). A removed budget is not listed.
   */
  listOf(groupId: string, month: string): Promise<BudgetView[]>;
}
