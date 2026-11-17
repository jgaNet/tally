import { DomainEvent } from '@Architecture/Domain';

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/** An expense was recorded: it exists under the id it was born with, in the group it was recorded in, split as its kind says. */
export class ExpenseRecordedEvent extends DomainEvent<{ expenseId: string; groupId: string; splitKind: SplitKind }> {}

/** An expense was edited: it keeps the id it was born with, and the group it is in; its content, split as its kind says, is the one saved. */
export class ExpenseEditedEvent extends DomainEvent<{ expenseId: string; groupId: string; splitKind: SplitKind }> {}

/** An expense was deleted: it no longer exists, and counts in no balance. */
export class ExpenseDeletedEvent extends DomainEvent<{ expenseId: string; groupId: string }> {}
