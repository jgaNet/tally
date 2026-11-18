import { DomainEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A budget was set for a category of a group: its id, the group, the category and the amount. */
export class BudgetSetEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  amount: number;
}> {}

/** A budget was removed: its id, the group and the category. The months it passed stay kept, so a month is notified once. */
export class BudgetRemovedEvent extends DomainEvent<{ budgetId: string; groupId: string; category: Category }> {}

/**
 * A month's spending in a category passed its budget, for the first time that month: the group, the category, the month
 * (YYYY-MM), the budget, what the month spends, and the members to tell, as they were when this was decided (request 24).
 */
export class BudgetPassedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  month: string;
  budget: number;
  spent: number;
  memberIds: string[];
}> {}
