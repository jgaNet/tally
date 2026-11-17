/** A member's role in a group, as Groups answers it: the owner, or any other member. */
export type MemberRole = 'owner' | 'member';

/** A current member of a group, as Ledger needs it to decide: the account's id and its role. */
export interface GroupMember {
  memberId: string;
  role: MemberRole;
}

/**
 * Ledger's own port onto Groups: who may be in a split, and who may change an expense. Ledger asks it when it decides,
 * in its own words; the adapter answers over Groups' read model (ADR 1, T3). No domain imports Groups.
 */
export interface IGroupMembers {
  /**
   * The current members of a group, each with its role, in the order they joined, when `askedBy` is one of them; null
   * otherwise, as if the group did not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<GroupMember[] | null>;
}
