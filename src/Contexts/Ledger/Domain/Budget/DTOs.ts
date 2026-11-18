import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * A group's budget for a category as the store keeps it (request 24, docs/adr/0023): the amount it is set to, `undefined` once it is
 * removed, and every month it has been passed in, so that the notice of a month is made once, whatever is set or removed after.
 */
export interface BudgetSnapshot {
  id: string;
  groupId: string;
  category: Category;
  amount?: number;
  /** The months it was passed in, `YYYY-MM`, the earliest first. */
  passedMonths: string[];
  version: number;
}

/** A budget as the queries answer it: the category's amount, and what the current month spends in it (request 24). */
export interface BudgetView {
  category: Category;
  amount: number;
  spent: number;
}
