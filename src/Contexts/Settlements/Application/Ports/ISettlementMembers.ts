/**
 * Settlements' port to Groups, which Settlements owns (ADR 6): who the members of a group are, in the words Settlements decides
 * with, and the group's currency, which a payment through the provider is made in. Answered by an adapter over Groups' read model;
 * read by the commands and the query that decide on a settlement.
 */
export interface ISettlementMembers {
  /** The ids of the group's current members in the order they joined, the earliest first; none when there is no such group. */
  membersOf(groupId: string): Promise<string[]>;
  /** Whether the account is a current member of the group. */
  isMemberOf(groupId: string, accountId: string): Promise<boolean>;
  /**
   * Whether the group is archived (request 27): read by each command that would settle or refund in it, inside its transaction, so it
   * takes no lock; the command refuses by GroupArchived. Groups decides it and answers (ADR 18).
   */
  archivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether an administrator has suspended the account (request 34): read by each command an account starts, inside its transaction, so it
   * takes no lock; the command refuses by AccountSuspended. Groups decides it and answers.
   */
  suspendedOf(accountId: string): Promise<boolean>;
  /**
   * Whether the person deleted the account (request 35): read by the commands that start a payment through the provider or a netting with it,
   * inside their transaction, so it takes no lock; the command refuses by AccountDeleted. Groups decides it and answers.
   */
  deletedOf(accountId: string): Promise<boolean>;
  /** The group's currency, or null when there is no such group. */
  currencyOf(groupId: string): Promise<string | null>;
  /**
   * The groups both accounts are current members of, in the currency given and not archived, the earliest created first (request 32):
   * read by the netting, which settles in each of them in that order. Groups decides it and answers.
   */
  sharedGroupsOf(firstAccountId: string, secondAccountId: string, currency: string): Promise<string[]>;
  /** Every group with a current member, each with its current members in the order they joined (ADR 10). */
  groupsWithMembers(): Promise<{ groupId: string; memberIds: string[] }[]>;
}
