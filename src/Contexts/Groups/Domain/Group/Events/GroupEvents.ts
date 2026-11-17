import { DomainEvent } from '@Architecture/Domain';

/** A group was created: it exists under the id it was born with, and its owner is its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}

/** An account joined a group by an invitation: it is a member from now on, after the members who joined before it. */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/** A member left a group: it is no longer among the group's members, and its balance was passed to the owner in the same step. */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/** A member's balance passed to the group's owner when the member left (request 20): `amount` is what the leaver had. */
export class BalancePassedEvent extends DomainEvent<{
  groupId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
}> {}
