import { DomainEvent } from '@Architecture/Domain';

/** A group was created: it exists under the id it was born with, and its owner is its first member. */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string }> {}
