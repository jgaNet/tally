import { DomainEvent } from '@Architecture/Domain';

/** A group was created: its id, its name and currency, who created it (its first member), and when. */
export class GroupCreatedEvent extends DomainEvent<{
  groupId: string;
  name: string;
  currency: string;
  ownerId: string;
  createdAt: string;
}> {}

/** An account joined a group, and when: the member's place in the group's order is the order of these facts. */
export class MemberJoinedEvent extends DomainEvent<{
  groupId: string;
  accountId: string;
  joinedAt: string;
}> {}

/**
 * A member left a group with a balance, which passed to the group's owner in the same step (request 20): the leaver, the
 * owner it passed to, the amount (negative when the leaver was owed), and when. A balance of 0 passes nothing, and is recorded all the same.
 */
export class BalancePassedEvent extends DomainEvent<{
  groupId: string;
  fromId: string;
  toId: string;
  amount: number;
  passedAt: string;
}> {}

/** A member left a group, and when: it is no longer among the members, and what it did in the group stays as it was. */
export class MemberLeftEvent extends DomainEvent<{
  groupId: string;
  accountId: string;
  leftAt: string;
}> {}

/** A group was archived, and when: it is read only from then on, and every change in it is refused (request 27, ADR 20). */
export class GroupArchivedEvent extends DomainEvent<{
  groupId: string;
  archivedAt: string;
}> {}
