import { DomainEvent } from '@Architecture/Domain';

/**
 * A group was created, by its owner, who is its first member. Recorded by the group's creation and published after its
 * save; nothing reacts to it yet, so it is not an integration event (ADR 3 says when it becomes one). It is not a
 * membership fact: a member who joins later is announced by `MemberJoined` (feature 3).
 */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string; createdAt: Date }> {}

/**
 * An account joined a group, as its last member. Recorded by `Group.join()` and published after its save; nothing
 * reacts to it yet, so it is not an integration event (ADR 4). Ledger asks for the members when it decides (feature 4).
 */
export class MemberJoinedEvent extends DomainEvent<{ groupId: string; accountId: string; joinedAt: Date }> {}

/**
 * An account left a group: its membership ended, and it is no longer among the group's members. Recorded by `Group.leave()`
 * and published after its save; nothing reacts to it yet, so it is not an integration event. Ledger is not told: it reads the
 * members when it decides (feature 9, ADR 7).
 */
export class MemberLeftEvent extends DomainEvent<{ groupId: string; accountId: string; leftAt: Date }> {}

/**
 * A member left a group with a balance, which passed to the owner in the same step (request 20). Recorded by `Group.leave()`
 * beside `MemberLeft` and published after its save; nothing reacts to it yet, so it is not an integration event. Ledger counts it
 * when it reads the balances, through `GroupMembers` (ADR 16): the member's balance moves to the owner, and the member's is 0 after.
 */
export class BalancePassedEvent extends DomainEvent<{
  groupId: string;
  from: string;
  to: string;
  amount: number;
  at: Date;
}> {}
