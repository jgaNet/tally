import { DomainEvent } from '@Architecture/Domain';

/**
 * A group was created, by its owner, who is its first member. Recorded by `Group.register()`, once the group is stored
 * (docs/adr/0001). MemberJoined, for the members who join later, is feature 3's.
 */
export class GroupCreatedEvent extends DomainEvent<{
  groupId: string;
  name: string;
  currency: string;
  ownerId: string;
}> {}
