import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** One group's total of a person's shares, in one month (YYYY-MM, UTC) and one category, in the group's currency (request 37). */
export interface GroupSpendingRow {
  groupId: string;
  month: string;
  category: Category;
  amount: number;
}

/** The read side of a person's spending (request 37): a read model, never an aggregate (QUERY-READ-MODELS). */
export interface IInsightQueries {
  /**
   * The shares the account has in the expenses of the groups given, summed by group, month and category, for the groups
   * with at least one such share. Deleted expenses are not in the read model, so they count for nothing. It names no
   * caller beyond the account asked for, and is answered to that account only.
   */
  sharesOf(accountId: string, groupIds: string[]): Promise<GroupSpendingRow[]>;
}
