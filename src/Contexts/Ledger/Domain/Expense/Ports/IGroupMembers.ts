import { Id } from '@Architecture/Domain';

/** A member's role in a group: the owner, or a member who joined. */
export type GroupRole = 'owner' | 'member';

/**
 * Ledger's port to Groups, which it owns (ADR 3): who may be in a split, and who may change an expense. The ids of the
 * group's current members, in the order they joined; none when there is no such group. Answered by an adapter over
 * Groups' read model.
 */
export interface IGroupMembers {
  /** The group's current members in join order, none when there is no such group: read by the command deciding a split. */
  membersOf(groupId: string): Promise<Id[]>;
  /** Whether the account is a current member of the group: read by a query, outside any transaction. */
  isMember(groupId: string, accountId: Id): Promise<boolean>;
  /**
   * The role of the account in the group, or null when it is not a member (or there is no such group): read by a command
   * deciding who may change an expense, inside its own transaction, so it takes no lock.
   */
  roleOf(groupId: string, accountId: Id): Promise<GroupRole | null>;
  /**
   * Whether the account has been a member of the group, now or before it left (ADR 4): a former member's statement is read
   * by the members of the group, and an expense of theirs is kept as it was. Read by a query, outside any transaction.
   */
  hasBeenMember(groupId: string, accountId: Id): Promise<boolean>;
}
