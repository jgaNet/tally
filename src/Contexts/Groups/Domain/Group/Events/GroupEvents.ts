import { DomainEvent } from '@Architecture/Domain';

/** A group was created: its id, and the account that created it, which is its owner and its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}

/** An account joined a group by an invitation: the group, and the account that is now one of its members. */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/** A member left a group once its balance was 0: the group, and the account that is no longer one of its members. */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string }> {}
