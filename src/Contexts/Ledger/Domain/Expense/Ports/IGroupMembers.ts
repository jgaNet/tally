/**
 * Who may be in a split, as Ledger needs it (ADR 1 T3, docs/adr/0004): the group's current members, answered over Groups'
 * read model when Ledger decides. Ledger owns the port; Groups answers it through an adapter in Ledger's Infrastructure.
 */
export interface IGroupMembers {
  /**
   * The current members of the group, in the order they joined, when the caller is one of them: `undefined` otherwise,
   * as if the group did not exist.
   */
  membersOf(callerId: string, groupId: string): Promise<string[] | undefined>;
}
