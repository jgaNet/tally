/** A current member of a group, as Settlements needs it: the account's id. */
export interface SettlementMember {
  memberId: string;
}

/**
 * Settlements' own port onto Groups: who is a member of a group, in the order they joined, and in which currency the group
 * counts. Settlements asks it when it decides, in its own words; the adapter answers over Groups' read model (ADR 7). No
 * domain imports Groups.
 */
export interface ISettlementMembers {
  /**
   * The current members of a group, in the order they joined, when `askedBy` is one of them; null otherwise, as if the
   * group did not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<SettlementMember[] | null>;
  /** The currency the group counts in, when `askedBy` is one of its members; null otherwise, as if the group did not exist. */
  currencyOf(groupId: string, askedBy: string): Promise<string | null>;
}
