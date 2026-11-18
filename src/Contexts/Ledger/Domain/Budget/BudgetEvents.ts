import { DomainEvent } from '@Architecture/Domain';

import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';

/** The owner set the monthly budget of a category, the first time or again (request 24). Recorded by `Budget.set`. */
export class BudgetSetEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: ExpenseCategory;
  amount: number;
}> {}

/** The owner removed the budget of a category (request 24). Recorded by `Budget.remove`. */
export class BudgetRemovedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: ExpenseCategory;
}> {}

/**
 * What a month spends in a category went over the category's budget, the first time for that month (request 24). Recorded by
 * `Budget.pass`, once for a group, a category and a month. It carries the members to tell, as the group had them when it was decided, and
 * a policy publishes it to the other contexts.
 */
export class BudgetPassedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: ExpenseCategory;
  month: string;
  budget: number;
  spent: number;
  memberIds: readonly string[];
}> {}
