import { DomainEvent } from '@Architecture/Domain';

import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense was set up: its id, its group, and the member who pays it every month. */
export class RecurringExpenseSetUpEvent extends DomainEvent<{ recurringId: string; groupId: string; paidBy: string }> {}

/** A recurring expense was stopped by its payer or the owner: it no longer exists, and records no expense from then on. */
export class RecurringExpenseStoppedEvent extends DomainEvent<{ recurringId: string; groupId: string }> {}

/** A recurring expense ended because its payer or a member of its split left the group: it records no expense, and no longer exists. */
export class RecurringExpenseEndedEvent extends DomainEvent<{ recurringId: string; groupId: string }> {}

/**
 * The day of a recurring expense came: the expense it names, `expenseId`, is to be recorded with these values, dated `date`,
 * in `currency`. The id was made here, once, with the day; the expense recorded from this fact is built on it, so that a
 * redelivered fact finds it recorded (DOMAIN-IDENTITY, EVENT-AFTER-COMMIT).
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  expenseId: string;
  paidBy: string;
  currency: string;
  description: string;
  amount: number;
  date: string;
  split: SplitRequest;
}> {}
