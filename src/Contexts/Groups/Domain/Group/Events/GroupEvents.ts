import { DomainEvent } from '@Architecture/Domain';

/** A group was created: its id, and the account that created it, which is its owner and its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}
