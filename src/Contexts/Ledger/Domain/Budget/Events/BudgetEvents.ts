import { DomainEvent } from '@Architecture/Domain';

/** A budget was set for a category of a group, replacing the one it had if any: the group, the category and the amount a month may spend. */
export class BudgetSetEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: string;
  amount: number;
}> {}

/** A budget was removed: the category of the group has none any more. */
export class BudgetRemovedEvent extends DomainEvent<{ budgetId: string; groupId: string; category: string }> {}

/**
 * A month spent more than a category's budget, for the first time: the group, the category, the month (YYYY-MM), the budget, what the
 * month spent when it was decided, and the members of the group to tell, as they were then.
 */
export class BudgetPassedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: string;
  month: string;
  budget: number;
  spent: number;
  members: string[];
}> {}
