import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: its id, its group, and the member who paid it. */
export class ExpenseRecordedEvent extends DomainEvent<{ expenseId: string; groupId: string; paidBy: string }> {}
/** An expense was edited: its id, its group, and the member who paid it, who an edit never changes. */
export class ExpenseEditedEvent extends DomainEvent<{ expenseId: string; groupId: string; paidBy: string }> {}
/** An expense was deleted: its id and its group. It no longer exists, and counts in no balance. */
export class ExpenseDeletedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}
