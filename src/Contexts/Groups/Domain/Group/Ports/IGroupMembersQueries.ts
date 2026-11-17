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
  /** The group's currency, fixed when it was created; null when there is no such group. Read by a command that prices a payment. */
  currencyOf(groupId: string): Promise<string | null>;
  /**
   * Every group that has a current member, each with its current members in join order: read by a query outside any
   * transaction, to say what every member still owes (ADR 10). A group with none is not listed.
   */
  membersOfEveryGroup(): Promise<{ groupId: string; memberIds: string[] }[]>;
  /**
   * The balances passed to the owner when members left the group, in the order they passed (request 20): each leaver's balance
   * at the time, from and to whom. Kept for good, a former member who joined again keeps them. Read by Ledger when it reads a
   * balance, inside a command's transaction (so it takes no lock) or by a query.
   */
  passagesOf(groupId: string): Promise<{ from: string; to: string; amount: number }[]>;
}
