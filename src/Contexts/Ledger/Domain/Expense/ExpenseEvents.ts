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
