import { DomainEvent } from '@Architecture/Domain';

/**
 * A group was created, by its owner, who is its first member. Recorded by the group's creation and published after its
 * save; nothing reacts to it yet, so it is not an integration event (ADR 3 says when it becomes one). It is not a
 * membership fact: a member who joins later is announced by `MemberJoined` (feature 3).
 */
export class GroupCreatedEvent extends DomainEvent<{ groupId: string; ownerId: string; createdAt: Date }> {}
