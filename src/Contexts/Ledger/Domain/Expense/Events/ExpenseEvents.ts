import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: its id, its group, and the member who paid it. */
export class ExpenseRecordedEvent extends DomainEvent<{ expenseId: string; groupId: string; paidBy: string }> {}
