/**
 * Ledger's own port onto Groups: who may be in a split. Ledger asks it when it decides, in its own words; the adapter
 * answers over Groups' read model (ADR 1, T3). No domain imports Groups.
 */
export interface IGroupMembers {
  /**
   * The current members of a group, as account ids in the order they joined, when `askedBy` is one of them; null
   * otherwise, as if the group did not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<string[] | null>;
}
