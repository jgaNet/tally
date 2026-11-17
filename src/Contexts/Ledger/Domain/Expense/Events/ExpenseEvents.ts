import { DomainEvent } from '@Architecture/Domain';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * An expense was recorded: its id, its group, who paid it, its amount, how it was split, its shares as they were
 * recorded, and when it was recorded. The shares travel with the event, so a reaction that tells members of them reads
 * the split as it was recorded, not as an edit after it left it.
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  shares: { memberId: string; amount: number }[];
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
