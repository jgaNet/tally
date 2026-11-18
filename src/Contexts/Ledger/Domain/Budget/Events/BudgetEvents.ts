import { DomainEvent } from '@Architecture/Domain';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A budget was set, or set again: its group, its category and its amount in the group's currency. */
export class BudgetSetEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  amount: number;
  setAt: string;
}> {}

/** A budget was removed by the owner of its group: it no longer limits its category, and no month is judged against it. */
export class BudgetRemovedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  removedAt: string;
}> {}

/**
 * A month's spending in a category passed its budget, for the first time that month: the month (`YYYY-MM`, UTC), the
 * budget, what the month spends, and the members of the group to tell, as Groups had them when this was decided.
 */
export class BudgetPassedEvent extends DomainEvent<{
  budgetId: string;
  groupId: string;
  category: Category;
  month: string;
  budget: number;
  spent: number;
  memberIds: string[];
  passedAt: string;
}> {}
