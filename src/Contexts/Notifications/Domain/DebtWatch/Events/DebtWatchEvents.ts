import { DomainEvent } from '@Architecture/Domain';

/** A member was seen owing more than the threshold in a group: the sweep at `at` notes the debt from it (ADR 10). */
export class DebtNotedEvent extends DomainEvent<{ watchId: string; groupId: string; memberId: string; at: string }> {}

/** A member was seen owing no more than the threshold again: the debt is no longer noted, from the sweep at `at`. */
export class DebtClearedEvent extends DomainEvent<{ watchId: string; groupId: string; memberId: string; at: string }> {}

/** A member is reminded of a debt that lasted: what they owed at `at`, in the group (`amount`, a whole number above the threshold). */
export class ReminderIssuedEvent extends DomainEvent<{
  watchId: string;
  groupId: string;
  memberId: string;
  amount: number;
  at: string;
}> {}
