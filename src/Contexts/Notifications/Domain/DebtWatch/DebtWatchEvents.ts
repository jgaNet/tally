import { DomainEvent } from '@Architecture/Domain';

/** A run saw a member owe more than the threshold in a group, and had not seen them so: the debt is noted from that run (request 18, ADR 15). */
export class DebtNotedEvent extends DomainEvent<{ groupId: string; memberId: string; at: string }> {}

/** A run saw a noted member owe the threshold or less, or no longer be a member: the debt is no longer noted (request 18, ADR 15). */
export class DebtClearedEvent extends DomainEvent<{ groupId: string; memberId: string; at: string }> {}

/** A run reminded a member whose debt had lasted a period, of what they still owed, with the notice it made (request 18, ADR 15). */
export class ReminderIssuedEvent extends DomainEvent<{
  groupId: string;
  memberId: string;
  noticeId: string;
  owed: number;
  at: string;
}> {}
