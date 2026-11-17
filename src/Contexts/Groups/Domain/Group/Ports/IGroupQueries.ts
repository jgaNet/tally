/** What a signed-in person reads of a group: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
}

/** A member of a group as the members' list answers it: the account, its name, its role and when it joined. */
export interface MemberView {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

/** The read side of the groups' store: what the queries answer, read at once. */
export interface IGroupQueries {
  /** The group, when this account is one of its members: undefined otherwise, as if the group did not exist. */
  findGroupOf(memberId: string, groupId: string): Promise<GroupView | undefined>;
  /** The groups this account is a member of, the most recently created first. */
  listGroupsOf(memberId: string): Promise<GroupView[]>;
  /** The members of the group, in the order they joined, when this account is one of them: undefined otherwise. */
  listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | undefined>;
  /**
   * Whether the account is, or has been, a member of the group, current or former (docs/adr/0009). It does not check the
   * caller: a read that needs a caller asks the caller's membership first, through `listMembersOf`.
   */
  everMemberOf(accountId: string, groupId: string): Promise<boolean>;
}
