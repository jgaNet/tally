/**
 * Groups' read side for other contexts (ADR 3): who is a member of a group, by account id. Another context reads it
 * through its own port over this one; it is a read model, never an aggregate (QUERY-READ-MODELS).
 */
export interface IGroupMembership {
  /** The account ids of a group's members, in the order they joined, the owner first; empty for a group that does not exist. */
  listMemberIds(groupId: string): Promise<string[]>;
}
