import { DomainEvent } from '@Architecture/Domain';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';

/** An expense was recorded: its id, its group, who paid it, its amount, how it was split, and when it was recorded. Its shares are read back from the aggregate's store. */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  recordedAt: string;
}> {}

/** An expense was edited: its id, its group, who paid it (unchanged by an edit), its new amount, how it is now split, and when it was edited. Its new shares are read back from the store. */
export class ExpenseEditedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  editedAt: string;
}> {}

/** An expense was deleted: its id, its group, and when it was deleted. It is gone from every read from then on. */
export class ExpenseDeletedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  deletedAt: string;
}> {}
