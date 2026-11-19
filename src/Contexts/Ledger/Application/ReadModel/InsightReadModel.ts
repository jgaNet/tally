import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** One line of an account's spending insights (request 37): what it spent in a currency, in a category, in a month (`YYYY-MM`), in its shares. */
export interface InsightReadModel {
  month: string;
  currency: string;
  category: Category;
  amount: number;
}

/** The shares an account has in the expenses of one group, summed by month and category, before the group's currency is known to the line. */
export interface GroupShareReadModel {
  groupId: string;
  month: string;
  category: Category;
  amount: number;
}
