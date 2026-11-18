import { Id } from '@Architecture/Domain';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** What a month spends in a category of a group: the sum of its live expenses of that category dated in that month (UTC). */
export interface IMonthlySpend {
  spentInMonth(groupId: Id, category: Category, month: string): Promise<number>;
}
