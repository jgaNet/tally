import { DomainEvent } from '@Architecture/Domain';

/**
 * An expense was recorded by a member of the group, who paid it. Recorded by `Expense.register()`, once the expense is
 * stored (docs/adr/0004). No integration event carries it: no other context reacts to it yet.
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  amount: number;
  paidBy: string;
}> {}
