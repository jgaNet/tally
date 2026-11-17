/** What a signed-in person reads of a group: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
}

/** The read side of the groups' store: what the queries answer, read at once. */
export interface IGroupQueries {
  /** The group, when this account is one of its members: undefined otherwise, as if the group did not exist. */
  findGroupOf(memberId: string, groupId: string): Promise<GroupView | undefined>;
  /** The groups this account is a member of, the most recently created first. */
  listGroupsOf(memberId: string): Promise<GroupView[]>;
}
