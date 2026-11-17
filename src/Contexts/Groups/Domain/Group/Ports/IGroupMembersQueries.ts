/**
 * The read-model port another context reads Groups' members through (ADR 3): the ids of a group's members, in the
 * order they joined, the owner first. It answers for any group, to a caller that is not a member too: it is a fact
 * another context decides with, never a screen. Empty when there is no such group.
 */
export interface IGroupMembersQueries {
  /**
   * The ids of the group's members in join order, empty when there is no such group. Read by the command that decides
   * on them, inside its own transaction: it sees what that transaction has written.
   */
  memberIdsOf(groupId: string): Promise<string[]>;
  /** Whether the account is a member of the group now, read by a query outside any transaction. */
  isMemberOf(groupId: string, accountId: string): Promise<boolean>;
  /**
   * The account's role in the group now: `owner` for the one who created it, `member` for whoever joined, null when it is
   * not a member or there is no such group. Read by the command deciding on it, inside its own transaction: no lock.
   */
  roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null>;
  /**
   * Whether the account has been a member of the group, now or before it left: a former member's statement is still read
   * by the members of the group (ADR 4). Asked by a query, outside any transaction.
   */
  hasBeenMemberOf(groupId: string, accountId: string): Promise<boolean>;
}
