import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

/** What a person spent in a month, in a currency and a category, across their groups: the sum of their shares (request 37). */
export interface InsightReadModel {
  month: string;
  currency: string;
  category: CategoryName;
  amount: number;
}
