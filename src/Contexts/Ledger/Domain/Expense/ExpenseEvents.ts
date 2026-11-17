import { DomainEvent } from '@Architecture/Domain';

/**
 * An expense was recorded, by the member who paid it. Recorded by the expense's creation and published after its save;
 * nothing reacts to it yet (the balances, feature 5, will), so it is not an integration event.
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
  amount: number;
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
