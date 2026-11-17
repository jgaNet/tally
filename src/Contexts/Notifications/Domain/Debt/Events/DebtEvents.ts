import { DomainEvent } from '@Architecture/Domain';

/** A member was seen owing more than the threshold in a group, from this run: the watch, the member, the group, what is owed and when it was noted. */
export class DebtNotedEvent extends DomainEvent<{
  watchId: string;
  groupId: string;
  memberId: string;
  owed: number;
  notedAt: string;
}> {}

/** A member was seen owing no more than the threshold again, so the noting of the debt ends. */
export class DebtClearedEvent extends DomainEvent<{
  watchId: string;
  groupId: string;
  memberId: string;
  clearedAt: string;
}> {}

/** A member's lasting debt was reminded at this run: what is still owed, and when. */
export class ReminderIssuedEvent extends DomainEvent<{
  watchId: string;
  groupId: string;
  memberId: string;
  owed: number;
  at: string;
}> {}
