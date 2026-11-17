import { DomainEvent } from '@Architecture/Domain';

import { ShareSnapshot, SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';

/**
 * An expense was recorded by a member of the group, who paid it. Recorded by `Expense.register()`, once the expense is
 * stored (docs/adr/0004). It carries the shares, which `ExpenseRecordedHandler` tells Notifications as the integration event
 * `ExpenseRecorded` (docs/adr/0017).
 */
export class ExpenseRecordedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  amount: number;
  paidBy: string;
  splitKind: SplitKind;
  shares: ShareSnapshot[];
}> {}

/**
 * An expense was given again, whole, by its payer or the group's owner. Recorded by `Expense.edit()`, once the edit is
 * stored (docs/adr/0006). No integration event carries it: the balances are Ledger's own read model.
 */
export class ExpenseEditedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  amount: number;
  paidBy: string;
  splitKind: SplitKind;
}> {}

/**
 * An expense was deleted by its payer or the group's owner. Recorded by `Expense.remove()`, once the deletion is stored
 * (docs/adr/0006). It is gone from every read and counts in no balance from that transaction on.
 */
export class ExpenseDeletedEvent extends DomainEvent<{
  expenseId: string;
  groupId: string;
  paidBy: string;
}> {}
