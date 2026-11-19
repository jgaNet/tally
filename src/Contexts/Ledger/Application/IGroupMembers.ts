/** The role a member has in their group: the owner, who created it, or a member who joined. */
export type MemberRole = 'owner' | 'member';

/** A member of a group, as Ledger needs them to decide a change to an expense: the account, and its role. */
export interface MemberOfGroup {
  memberId: string;
  role: MemberRole;
}

/**
 * The members of a group, as Ledger needs them to decide an expense: a port Ledger owns, in its own words (ADR 5), answered
 * by an adapter over Groups' read model (`GroupMembersOfGroups`, in the wiring of this context). It answers each member's
 * role too, so that Ledger knows who the group's owner is (feature 6).
 */
/** A balance that passed from a member who left the group to its owner, when it left (request 20). */
export interface BalancePass {
  from: string;
  to: string;
  amount: number;
}

export interface IGroupMembers {
  /**
   * The members of the group, in the order they joined, with their roles, if `askedBy` is one of them; `undefined` when it
   * is not, or the group is not there: to anyone else a group does not exist.
   */
  membersOf(groupId: string, askedBy: string): Promise<MemberOfGroup[] | undefined>;
  /**
   * The balances that passed to owners when members left the group, in the order they passed (request 20): Ledger counts each in the
   * balances it reports, from the member to the owner, so that the balances still add up to 0 and a member who left and joins again
   * starts at 0. Asked by no member: it is what the balances are read with.
   */
  passesOf(groupId: string): Promise<BalancePass[]>;
  /**
   * Whether the group is archived (request 27): then no change is made in it, and each one is refused by `GroupArchived` (ADR 24). Asked
   * by no member: a change asks it after the member is checked, as it asks the members, and the answer is only the flag.
   */
  archivedOf(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (request 34): then it may not record an expense or set up a recurring expense, in any group, and the
   * background job records no expense for its recurring ones (ADR 32). Asked by no member: it is the answer about the account asking.
   */
  suspendedOf(accountId: string): Promise<boolean>;
}
