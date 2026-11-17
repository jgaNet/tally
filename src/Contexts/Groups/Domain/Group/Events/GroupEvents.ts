import { DomainEvent } from '@Architecture/Domain';

/** A group was created: its id, and the account that created it, which is its owner and its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}

/** An account joined a group by an invitation: the group, and the account that is now one of its members. */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/** A member left a group: the group, and the account that is no longer one of its members. */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/**
 * The balance a member had when it left was passed to the group's owner, in the same step: the group, the member it
 * passed from, the one it passed to, and the amount (request 20). Recorded beside MemberLeft.
 */
export class BalancePassedEvent extends DomainEvent<{ groupId: string; from: string; to: string; amount: number }> {}
