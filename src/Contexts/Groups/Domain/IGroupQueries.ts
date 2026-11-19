/** What `GetGroup` and `GetMyGroups` answer: a group as one of its members reads it (read models, never aggregates). */
export interface GroupView {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  /** When the group was archived (request 27): present once it is archived, and only then. */
  archivedAt?: string;
}

/** What `GetGroupMembers` answers for one member: the account, its name, its role, and when it joined. */
export interface MemberView {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

/**
 * A balance that passed to the owner when a member left (request 20): from the member who left, to the owner, the amount, and when it
 * passed. `id` names the pass for good (the order it was made in, within the group), as the audit names it (request 28).
 */
export interface PassView {
  id: string;
  from: string;
  to: string;
  amount: number;
  at: string;
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
  /**
   * Whether the group is archived (request 27). Asked by no member: a context asks it before it changes something in the group, through its
   * own port, and refuses by `GroupArchived` if it is (ADR 24); nothing else of the group is read by it.
   */
  archivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (request 34). Asked by no member: a context asks it about the account that asks it, through its own port, and
   * refuses by `AccountSuspended` if it is (ADR 32); nothing else of the account is read by it.
   */
  suspendedOf(accountId: string): Promise<boolean>;
}
