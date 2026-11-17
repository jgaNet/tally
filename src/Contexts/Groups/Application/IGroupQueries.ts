/** What `GetGroup` and `GetMyGroups` answer: a group as one of its members reads it (read models, never aggregates). */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
}

/** What `GetGroupMembers` answers for one member: the account, its name, its role, and when it joined. */
export interface MemberView {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

/** The read side of the groups. Every read is made for a member: a group the caller is not in does not exist for them. */
export interface IGroupQueries {
  /** The group, if `memberId` is one of its members. */
  groupOf(id: string, memberId: string): Promise<GroupView | undefined>;
  /** The groups `memberId` is a member of, the most recently created first. */
  groupsOf(memberId: string): Promise<GroupView[]>;
  /** The members of the group in the order they joined, the owner first, if `memberId` is one of them. */
  membersOf(id: string, memberId: string): Promise<MemberView[] | undefined>;
}
