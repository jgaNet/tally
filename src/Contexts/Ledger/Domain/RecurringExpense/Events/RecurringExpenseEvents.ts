import { DomainEvent } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense was set up: it exists under the id it was born with, in the group it was set up in. */
export class RecurringExpenseSetUpEvent extends DomainEvent<{
  recurringExpenseId: string;
  groupId: string;
  paidBy: string;
}> {}

/** A recurring expense was stopped: it no longer exists, and no expense is recorded for it from then on. */
export class RecurringExpenseStoppedEvent extends DomainEvent<{ recurringExpenseId: string; groupId: string }> {}

/**
 * The day of a recurring expense came: its expense is to be recorded under `expenseId`, the id the day was born with, dated `day`,
 * paid by `paidBy` and split as `split` says, for the category it names (request 24). `members` are the payer and the members of the split, all of them members of the
 * group when the day came: the reaction records the expense among them (ADR 14).
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<{
  recurringExpenseId: string;
  expenseId: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  day: string;
  split: SplitInput;
  category: string;
  members: string[];
}> {}

/** A recurring expense ended, because its payer or a member of its split is no longer in the group: no expense is recorded for it. */
export class RecurringExpenseEndedEvent extends DomainEvent<{ recurringExpenseId: string; groupId: string }> {}
