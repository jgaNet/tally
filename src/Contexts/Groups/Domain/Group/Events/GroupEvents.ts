import { DomainEvent } from '@Architecture/Domain';

/**
 * A group was created, by its owner, who is its first member. Recorded by `Group.register()`, once the group is stored
 * (docs/adr/0001).
 */
export class GroupCreatedEvent extends DomainEvent<{
  groupId: string;
  name: string;
  currency: string;
  ownerId: string;
}> {}

/**
 * An account joined a group by an invitation. Recorded by `Group.join()`, once the membership is stored. No integration
 * event carries it: Ledger asks Groups who the members are when it decides (conventions/domain.yaml, T3).
 */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string }> {}

/**
 * A member left a group, once its balance in it was 0 (request 9). Recorded by `Group.leave()`, once the departure is
 * stored. No integration event carries it: Ledger asks Groups who the members are when it decides (docs/adr/0009).
 */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string }> {}
