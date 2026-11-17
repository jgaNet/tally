import { DomainEvent } from '@Architecture/Domain';

import { ExpenseShare, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** An expense was recorded: its id, its group, the member who paid it, its amount, how it was split, and each member's share. */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  shares: ExpenseShare[];
}> {}
/** An expense was edited: its id, its group, the member who paid it (an edit never changes it), and how it is split now. */
export class ExpenseEditedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  splitKind: SplitKind;
}> {}
/** An expense was deleted: its id and its group. It no longer exists, and counts in no balance. */
export class ExpenseDeletedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}
