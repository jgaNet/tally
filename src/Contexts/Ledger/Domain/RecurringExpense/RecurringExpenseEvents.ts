import { DomainEvent } from '@Architecture/Domain';

import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/** A recurring expense was set up by the member who will pay it every month (request 23). Recorded by its creation. */
export class RecurringExpenseSetUpEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  paidBy: string;
}> {}

/** A recurring expense was stopped by its payer or the group's owner: it no longer exists, and records nothing from then on. */
export class RecurringExpenseStoppedEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
}> {}

/**
 * A recurring expense ended, because its payer or a member of its split is no longer a member of the group: it no longer exists, and
 * the day that came records no expense. Recorded by the background job's sweep, never by a read.
 */
export class RecurringExpenseEndedEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
}> {}

/**
 * A day of a recurring expense came, at a run of the background job: the expense that day records is `expenseId`, born here, and
 * carries everything a recording needs (its payer, description, amount and split as given), so the policy that records it reads
 * nothing back. Published after the save, through the outbox; the policy records the expense with `expenseId`, and a redelivery finds it
 * recorded (ADR 20).
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<{
  recurringId: string;
  expenseId: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  day: string;
  split: SplitRequest;
  category: ExpenseCategory;
}> {}
