/** What a member reads of a group: the group as the screens show it. */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
}

/** What a member reads of another member: the account, its name, its role, and when it joined. */
export interface MemberView {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
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
  /**
   * The members of a group, in the order they joined, the owner first, when this account is one of them; null
   * otherwise (as if the group did not exist).
   */
  listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | null>;
  /**
   * Whether the account has ever been a member of the group, a former member included, when `askedBy` is one of its
   * current members; null otherwise, as if the group did not exist (request 9: a former member's statement is read).
   */
  hasBeenMemberOf(askedBy: string, groupId: string, accountId: string): Promise<boolean | null>;
  /**
   * The current members of every group, each group's members in the order they joined (ADR 10). It names no caller: it is
   * read by the background job, which decides for every group, and never answered to a person.
   */
  membersOfEveryGroup(): Promise<GroupMembership[]>;
}

/** A current member of a group, as the background job reads it: the group, and the account. */
export interface GroupMembership {
  groupId: string;
  memberId: string;
}
