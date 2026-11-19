import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * What a person spent in a group, in a month, in a category, as the group's expenses keep it (request 37, docs/adr/0037): the sum of the
 * person's shares of the group's expenses of that category dated in that month (UTC), in the group's currency. Deleted expenses are not in
 * the store, so they count for nothing.
 */
export interface SharesOfMonth {
  groupId: string;
  month: string;
  category: Category;
  amount: number;
}

/** One line of a person's spending insights (request 37): a month, a currency and a category, and the amount spent in them. */
export interface InsightView {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}
