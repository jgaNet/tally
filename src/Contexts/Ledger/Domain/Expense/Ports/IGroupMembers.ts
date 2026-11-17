/** A member of a group as Ledger needs it: the account, and its role in the group (docs/adr/0006). */
export interface GroupMember {
  memberId: string;
  role: 'owner' | 'member';
}

/**
 * Who may be in a split, as Ledger needs it (ADR 1 T3, docs/adr/0004): the group's current members, answered over Groups'
 * read model when Ledger decides. Ledger owns the port; Groups answers it through an adapter in Ledger's Infrastructure.
 * The roles are asked too: the group's owner may change an expense its payer made (request 6, docs/adr/0006).
 */
export interface IGroupMembers {
  /**
   * The current members of the group, in the order they joined, with their roles, when the caller is one of them:
   * `undefined` otherwise, as if the group did not exist.
   */
  membersOf(callerId: string, groupId: string): Promise<GroupMember[] | undefined>;
  /**
   * Whether the account is, or has been, a member of the group, current or former (docs/adr/0009): a former member's statement
   * stays readable by the group's members. A read asks the caller's membership first, through `membersOf`.
   */
  hasBeenMember(groupId: string, memberId: string): Promise<boolean>;
}
