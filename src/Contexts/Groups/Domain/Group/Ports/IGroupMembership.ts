/**
 * Groups' read side for other contexts (ADR 3): who is a member of a group, by account id. Another context reads it
 * through its own port over this one; it is a read model, never an aggregate (QUERY-READ-MODELS).
 */
export interface IGroupMembership {
  /** The account ids of a group's members now, in the order they joined, the owner first; empty for a group that does not exist. */
  listMemberIds(groupId: string): Promise<string[]>;
  /** Whether this account has ever been a member of the group, whether it is one now or has left. */
  hasBeenMember(groupId: string, accountId: string): Promise<boolean>;
  /** The role of an account in a group: `owner` for the one who made it, `member` for the others, null when it is not a member now (or the group does not exist). */
  roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null>;
}
