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

/** A member left a group, and when: it is no longer among the members, and what it did in the group stays as it was. */
export class MemberLeftEvent extends DomainEvent<{
  groupId: string;
  accountId: string;
  leftAt: string;
}> {}
