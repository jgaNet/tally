import { DomainEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * A recurring expense was set up by a member of the group, who pays it every month (request 23). Recorded by
 * `RecurringExpense.setUp()`, once it is stored.
 */
export class RecurringExpenseSetUpEvent extends DomainEvent<{ recurringId: string; groupId: string }> {}

/**
 * A recurring expense was stopped by its payer or the group's owner: it no longer exists (request 23). Recorded by
 * `RecurringExpense.stop()`, once the deletion is stored.
 */
export class RecurringExpenseStoppedEvent extends DomainEvent<{ recurringId: string; groupId: string }> {}

/**
 * The day of a recurring expense came, and the background job records its expense (request 23, docs/adr/0022). It carries the id
 * of the expense that day records, and everything that expense is made of as it was given, so that the reaction records it with
 * that id and records it once: a redelivered fact finds the expense recorded.
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<{
  recurringId: string;
  expenseId: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  date: string;
  split: SplitInput;
  category: Category;
}> {}

/**
 * A recurring expense ended because its payer or a member of its split is no longer a member of the group (request 23, docs/adr/0022).
 * It records no expense from that day on, and it no longer exists. Recorded by `RecurringExpense.runDay()`, once the deletion is stored.
 */
export class RecurringExpenseEndedEvent extends DomainEvent<{ recurringId: string; groupId: string }> {}

/**
 * A recurring expense moved from a merged group to the group kept (request 31, docs/adr/0031): its id, and the two groups. Recorded by
 * `RecurringExpense.moveTo()`, once the move is stored; its payer, split, next day and version are unchanged.
 */
export class RecurringExpenseMovedEvent extends DomainEvent<{ recurringId: string; from: string; to: string }> {}
