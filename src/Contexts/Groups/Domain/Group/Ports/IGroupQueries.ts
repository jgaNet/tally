/** What a signed-in person reads of a group: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  /** ISO 8601, UTC: when the group was archived (request 27). Absent while the group is not archived. */
  archivedAt?: string;
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
   * Whether the group is archived (request 27, docs/adr/0026): nothing in it changes any more. False for a group that does not exist; a
   * change asks the caller's membership first, through `findGroupOf` or `listMembersOf`.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is, or has been, a member of the group, current or former (docs/adr/0009). It does not check the
   * caller: a read that needs a caller asks the caller's membership first, through `listMembersOf`.
   */
  everMemberOf(accountId: string, groupId: string): Promise<boolean>;
  /**
   * The ids of the group's current members, in the order they joined, for a background job that acts for the group and has no
   * caller (request 23, docs/adr/0022). It answers an empty list for a group that does not exist. A read that needs a caller
   * asks the caller's membership first, through `listMembersOf`.
   */
  currentMemberIdsOf(groupId: string): Promise<string[]>;
  /**
   * What the leaves of the group passed to its owner (request 20, docs/adr/0019): the owner, and each member who left it or joined
   * it again after leaving, with the balance its leaves passed and whether it is a current member. Undefined for a group that does
   * not exist. Ledger reads it through GroupMembers when it reads the balances.
   */
  passedBalancesOf(groupId: string): Promise<PassedBalancesView | undefined>;
}

/** A member whose leaves passed a balance to the owner, as Ledger reads it (docs/adr/0019). */
export interface PassedMemberView {
  memberId: string;
  passed: number;
  current: boolean;
}

/** The owner of a group and what its members' leaves passed to the owner. */
export interface PassedBalancesView {
  ownerId: string;
  members: PassedMemberView[];
}
