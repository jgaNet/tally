import { DomainEvent } from '@Architecture/Domain';

/** A group was created: it exists under the id it was born with, and its owner is its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}

/** An account joined a group by an invitation: it is a member from now on, after the members who joined before it. */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/** A member left a group, once their balance in it was 0: it is no longer among the group's members. */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string }> {}
