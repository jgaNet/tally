/**
 * Who may be in a split, as Ledger asks it (conventions/domain.yaml, ADR 1 T3, ADR 6): a port Ledger owns, in its own words.
 * `membersOf` answers the group's current members, in the order they joined, or `undefined` when there is no such group.
 * The adapter that answers it is Ledger's infrastructure over Groups' roster, so no domain imports Groups.
 */
export interface IGroupMembers {
  membersOf(groupId: string): Promise<string[] | undefined>;
}
