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

/** A balance that passed to the owner when a member left (request 20): from the member who left, to the owner, the amount. */
export interface PassView {
  from: string;
  to: string;
  amount: number;
}

/** The read side of the groups. Every read is made for a member: a group the caller is not in does not exist for them. */
export interface IGroupQueries {
  /** The group, if `memberId` is one of its members. */
  groupOf(id: string, memberId: string): Promise<GroupView | undefined>;
  /** The groups `memberId` is a member of, the most recently created first. */
  groupsOf(memberId: string): Promise<GroupView[]>;
  /** The members of the group in the order they joined, the owner first, if `memberId` is one of them. */
  membersOf(id: string, memberId: string): Promise<MemberView[] | undefined>;
  /**
   * The current members of every group, as account ids, one entry per group that has any, in no order. Not asked for a member: it is
   * what a job reads (the reminders of request 18, through Settlements), never what a screen shows.
   */
  currentMembers(): Promise<{ groupId: string; memberIds: string[] }[]>;
  /**
   * The balances that passed to owners when members left the group, in the order they passed (request 20). Asked by no member: Ledger
   * reads it when it reads the balances, through its own `GroupMembers` port, so that a former member's balance is counted with the owner's.
   */
  passesOf(groupId: string): Promise<PassView[]>;
}
