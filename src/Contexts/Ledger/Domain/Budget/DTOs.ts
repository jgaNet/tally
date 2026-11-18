import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A group's budget for one category as it is stored: its amount (null once removed), and the months it has been passed in. */
export interface IBudgetSnapshot {
  _id: string;
  groupId: string;
  category: Category;
  /** The budget in the group's currency; null when none is set (never set, or removed). */
  amount: number | null;
  /** The months, YYYY-MM, in which the spending passed the budget: a notice is made once for each (request 24). */
  passedMonths: string[];
  version: number;
}
