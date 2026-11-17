import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: its id, its group, who paid it, its amount, and when it was recorded. Its split is read back from the aggregate's store. */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  recordedAt: string;
}> {}
