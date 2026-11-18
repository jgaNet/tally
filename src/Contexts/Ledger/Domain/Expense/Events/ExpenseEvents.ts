import { DomainEvent } from '@Architecture/Domain';

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * An expense was recorded: it exists under the id it was born with, in the group it was recorded in, split as its kind says,
 * paid by `paidBy`, with each member's share of it as recorded.
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  splitKind: SplitKind;
  paidBy: string;
  shares: { memberId: string; amount: number }[];
}> {}

/** An expense was edited: it keeps the id it was born with, and the group it is in; its content, split as its kind says, is the one saved. */
export class ExpenseEditedEvent extends DomainEvent<{ expenseId: string; groupId: string; splitKind: SplitKind }> {}

/** An expense was deleted: it no longer exists, and counts in no balance. */
export class ExpenseDeletedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}

/** An expense moved to another group, when its group was merged into one (request 31): it keeps everything but its group. */
export class ExpenseMovedEvent extends DomainEvent<{ expenseId: string; fromGroupId: string; toGroupId: string }> {}
