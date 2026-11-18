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
   * The groups the account is a current member of, archived ones included (request 37): read by a query outside any transaction, to say
   * what a person spent across them. A merged group is gone, and what it held is in the group it was merged into.
   */
  groupIdsOf(accountId: string): Promise<string[]>;
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
  /**
   * Whether the group is archived: read by the other contexts before they change anything in it, through the port each owns (request 27).
   * Read inside the command deciding the change, so it takes no lock.
   */
  isArchivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether an administrator has suspended the account (request 34): read by the other contexts before they start anything, through the port
   * each owns, inside the command deciding it, so it takes no lock; the command refuses by AccountSuspended.
   */
  isSuspendedOf(accountId: string): Promise<boolean>;
  /**
   * Which of these accounts their person deleted (request 35), in the order given: read by the other contexts, through the port each owns, inside
   * the command deciding a split, a payment or a netting, so it takes no lock. A deleted account stays a member of its groups, with its balance,
   * but nothing new is done with it: the command refuses by AccountDeleted, or leaves it out of what it tells.
   */
  deletedAmong(accountIds: string[]): Promise<string[]>;
  /** The group's currency, fixed when it was created; null when there is no such group. Read by a command that prices a payment. */
  currencyOf(groupId: string): Promise<string | null>;
  /**
   * The groups both accounts are current members of, in the currency given and not archived, the earliest created first (request 32).
   * Read by the command that nets what two people owe each other, inside its transaction, so it takes no lock.
   */
  groupsSharedBy(firstAccountId: string, secondAccountId: string, currency: string): Promise<string[]>;
  /**
   * Every group that has a current member, each with its current members in join order: read by a query outside any
   * transaction, to say what every member still owes (ADR 10). A group with none is not listed; a deleted account is left out of them (request 35).
   */
  membersOfEveryGroup(): Promise<{ groupId: string; memberIds: string[] }[]>;
  /**
   * The balances passed to the owner when members left the group, in the order they passed (request 20): each leaver's balance
   * at the time, from and to whom. Kept for good, a former member who joined again keeps them. Read by Ledger when it reads a
   * balance, inside a command's transaction (so it takes no lock) or by a query.
   */
  passagesOf(groupId: string): Promise<{ from: string; to: string; amount: number }[]>;
}
