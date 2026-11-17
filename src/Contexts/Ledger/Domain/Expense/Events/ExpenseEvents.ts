import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: it exists under the id it was born with, in the group it was recorded in. */
export class ExpenseRecordedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}
