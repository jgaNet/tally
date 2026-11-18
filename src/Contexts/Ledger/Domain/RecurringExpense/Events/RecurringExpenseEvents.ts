import { DomainEvent } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** A recurring expense was set up: its id, its group, its payer, and the day of its first month. */
export class RecurringExpenseSetUpEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  paidBy: string;
  startsOn: string;
  setUpAt: string;
}> {}

/**
 * The day of a recurring expense came: its expense is to be recorded with the identity `expenseId` (born with this fact, so a
 * redelivery finds it recorded), dated `day`, with the payer, description, amount and split the recurring expense was set up
 * with. The next day of the recurring expense is already moved on when this is published.
 */
export class RecurringExpenseDayCameEvent extends DomainEvent<{
  recurringId: string;
  expenseId: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  day: string;
  splitRequest: SplitRequest;
  category: Category;
  cameAt: string;
}> {}

/** A recurring expense ended because its payer or a member of its split left the group: it no longer exists, and records nothing for that day. */
export class RecurringExpenseEndedEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  endedAt: string;
}> {}

/** A recurring expense was stopped by its payer or the owner of its group: it no longer exists. The expenses it recorded stay. */
export class RecurringExpenseStoppedEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  stoppedAt: string;
}> {}

/** A recurring expense moved to the group its group was merged into (request 31): its id stays, and its expenses are recorded there from then on. */
export class RecurringExpenseMovedEvent extends DomainEvent<{
  recurringId: string;
  groupId: string;
  fromGroupId: string;
  movedAt: string;
}> {}
