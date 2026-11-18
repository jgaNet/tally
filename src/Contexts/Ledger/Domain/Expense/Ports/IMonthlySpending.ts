import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * What a month spends in a category of a group, as the budget's decision reads it (request 24, docs/adr/0023): the sum of the amounts of
 * the group's expenses of the category whose date is in the month, in UTC, deleted ones left out. It is read inside the reaction's
 * transaction, so it sees the expense that was just recorded or edited.
 */
export interface IMonthlySpending {
  spentIn(groupId: string, category: Category, month: string): Promise<number>;
}
