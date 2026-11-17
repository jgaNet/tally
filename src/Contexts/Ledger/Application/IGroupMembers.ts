/** A member's role in a group, in Ledger's words: the owner of the group, or any other member. */
export type GroupRole = 'owner' | 'member';

/** A member of a group as Ledger asks it: the account, and the role it has in the group (who may change an expense). */
export interface GroupMemberRole {
  readonly memberId: string;
  readonly role: GroupRole;
}

/**
 * Who may be in a split, as Ledger asks it (conventions/domain.yaml, ADR 1 T3, ADR 6): a port Ledger owns, in its own words.
 * `membersOf` answers the group's current members, in the order they joined, the owner first, each with its role; or
 * `undefined` when there is no such group. The adapter that answers it is Ledger's infrastructure over Groups' roster, so no
 * domain imports Groups.
 */
export interface IGroupMembers {
  membersOf(groupId: string): Promise<GroupMemberRole[] | undefined>;
  /**
   * Whether the account is, or has ever been, a member of the group (feature 9): a member who left keeps the statement of their
   * expenses, which the group's members still read. Answered over the same roster.
   */
  hasBeenMember(groupId: string, memberId: string): Promise<boolean>;
}
