import { DomainEvent } from '@Architecture/Domain';

/** An expense was recorded: its id, its group, who paid it, its amount, and when it was recorded. Its split is read back from the aggregate's store. */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  recordedAt: string;
}> {}

/** An expense was edited: its id, its group, who paid it (unchanged by an edit), its new amount, and when it was edited. Its new split is read back from the store. */
export class ExpenseEditedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  editedAt: string;
}> {}

/** An expense was deleted: its id, its group, and when it was deleted. It is gone from every read from then on. */
export class ExpenseDeletedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  deletedAt: string;
}> {}
