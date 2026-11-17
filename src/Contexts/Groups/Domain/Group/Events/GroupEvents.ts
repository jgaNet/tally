import { DomainEvent } from '@Architecture/Domain';

/** A group was created: its id, its name and currency, who created it (its first member), and when. */
export class GroupCreatedEvent extends DomainEvent<{
  groupId: string;
  name: string;
  currency: string;
  ownerId: string;
  createdAt: string;
}> {}
