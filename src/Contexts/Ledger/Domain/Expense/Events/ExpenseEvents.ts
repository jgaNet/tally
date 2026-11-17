import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: it exists under the id it was born with, in the group it was recorded in. */
export class ExpenseRecordedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}

/** An expense was edited: it keeps the id it was born with, and the group it is in; its content is the one saved. */
export class ExpenseEditedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}

/** An expense was deleted: it no longer exists, and counts in no balance. */
export class ExpenseDeletedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}
