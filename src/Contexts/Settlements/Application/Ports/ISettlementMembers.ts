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
  /** The group's currency, or null when there is no such group. */
  currencyOf(groupId: string): Promise<string | null>;
  /** Every group with a current member, each with its current members in the order they joined (ADR 10). */
  groupsWithMembers(): Promise<{ groupId: string; memberIds: string[] }[]>;
}
