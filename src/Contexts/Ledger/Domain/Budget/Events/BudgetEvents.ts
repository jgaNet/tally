import { DomainEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A group's budget for a category was set, or set again (request 24). Recorded by `Budget.set()`, once it is stored. */
export class BudgetSetEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  amount: number;
}> {}

/** A group's budget for a category was removed by its owner (request 24). Recorded by `Budget.remove()`, once it is stored. */
export class BudgetRemovedEvent extends DomainEvent<{ budgetId: string; groupId: string; category: Category }> {}

/**
 * A month's spending in a category passed the category's budget (request 24, docs/adr/0023). Recorded by `Budget.pass()`, once for a
 * group, a category and a month: it carries what the month spends when it was passed and the members to tell, and the reaction
 * tells each of them. `BudgetPassedIntegrationEvent` is what the other contexts are told (`BudgetPassedHandler`).
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
