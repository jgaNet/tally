import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * What a month spends in a category of a group (request 24): the sum of the amounts of the group's expenses of the category whose date
 * is in the month (YYYY-MM, in UTC), the deleted ones left out. Ledger's own read model of its expenses, read inside the reaction's
 * transaction, so it takes no lock of its own.
 */
export interface IBudgetSpending {
  spentIn(groupId: string, category: CategoryName, month: string): Promise<number>;
}
