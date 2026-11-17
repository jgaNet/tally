/** The role a member has in their group: the owner, who created it, or a member who joined. */
export type MemberRole = 'owner' | 'member';

/** A member of a group, as Ledger needs them to decide a change to an expense: the account, and its role. */
export interface MemberOfGroup {
  memberId: string;
  role: MemberRole;
}

/**
 * The members of a group, as Ledger needs them to decide an expense: a port Ledger owns, in its own words (ADR 5), answered
 * by an adapter over Groups' read model (`GroupMembersOfGroups`, in the wiring of this context). It answers each member's
 * role too, so that Ledger knows who the group's owner is (feature 6).
 */
export interface IGroupMembers {
  /**
   * The members of the group, in the order they joined, with their roles, if `askedBy` is one of them; `undefined` when it
   * is not, or the group is not there: to anyone else a group does not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<MemberOfGroup[] | undefined>;
}
