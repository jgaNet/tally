import { DomainEvent } from '@Architecture/Domain';

/** A member was seen owing more than 2000 in a group, by the run at `at`: the debt is noted from now (request 18). */
export class DebtNotedEvent extends DomainEvent<{ groupId: string; memberId: string; at: string }> {}

/** A member was seen owing 2000 or less in a group, after a debt that was noted: the note is cleared (request 18). */
export class DebtClearedEvent extends DomainEvent<{ groupId: string; memberId: string; at: string }> {}

/** A reminder was owed to a member for a lasting debt, and made at `at`, for `owes` still owed (request 18). */
export class ReminderIssuedEvent extends DomainEvent<{
  groupId: string;
  memberId: string;
  owes: number;
  at: string;
}> {}
