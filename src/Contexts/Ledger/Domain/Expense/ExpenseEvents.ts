import { DomainEvent } from '@Architecture/Domain';

import { ExpenseCategory } from './ExpenseCategory';
import { Share, SplitKind } from './Split';

/**
 * An expense was recorded, by the member who paid it. Recorded by the expense's creation and published after its save. Its
 * shares are the split's as recorded, so that the policy that publishes `ExpenseRecorded` to the other contexts (ADR 14) needs
 * to read nothing back. The fact the other contexts hear is the integration event, not this one.
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  shares: readonly Share[];
  /** What it was for and the day it was for (request 24), which the budget of its month is checked with. */
  category: ExpenseCategory;
  date: string;
}> {}

/**
 * An expense was given again, whole, by its payer or the group's owner (feature 6). Its payer is the one who paid it, and
 * is unchanged. Recorded by `Expense.revise` and published after its save; not an integration event, as nothing reads it
 * outside Ledger.
 */
export class ExpenseEditedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
  splitKind: SplitKind;
  category: ExpenseCategory;
  date: string;
}> {}

/**
 * An expense was deleted, by its payer or the group's owner (feature 6). It no longer exists once the deletion is stored, and
 * counts in no balance. Recorded by `Expense.delete` and published after its removal; not an integration event.
 */
export class ExpenseDeletedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
}> {}

/**
 * An expense moved from one group to another, when the group it was recorded in was merged into the other (request 31). Recorded by
 * `Expense.moveTo` and published after its move; nothing reacts to it. The expense keeps its id, its version and everything it says but its group.
 */
export class ExpenseMovedEvent extends DomainEvent<{ expenseId: string; from: string; to: string; at: Date }> {}
