/**
 * The members of a group, as Ledger needs them to decide an expense: a port Ledger owns, in its own words (ADR 5), answered
 * by an adapter over Groups' read model (`GroupMembersOfGroups`, in the wiring of this context).
 */
export interface IGroupMembers {
  /**
   * The accounts that are members of the group, in the order they joined, if `askedBy` is one of them; `undefined` when
   * it is not, or the group is not there: to anyone else a group does not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<string[] | undefined>;
}
