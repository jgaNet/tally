/** What a member reads of a group: the group as the screens show it. */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
}

/**
 * The read side of groups: read models, never aggregates (QUERY-READ-MODELS). A group is answered to its members
 * only: the membership is part of each read, so a group that is not the caller's is not found at all.
 */
export interface IGroupQueries {
  /** The group with this id when this account is one of its members, or null otherwise (as if it did not exist). */
  findGroupOf(memberId: string, groupId: string): Promise<GroupView | null>;
  /** The groups this account is a member of, the most recently created first. */
  listGroupsOf(memberId: string): Promise<GroupView[]>;
}
