/** A member's role in a group, in Ledger's words: the owner of the group, or any other member. */
export type GroupRole = 'owner' | 'member';

/** A member of a group as Ledger asks it: the account, and the role it has in the group (who may change an expense). */
export interface GroupMemberRole {
  readonly memberId: string;
  readonly role: GroupRole;
}

/**
 * Who may be in a split, as Ledger asks it (conventions/domain.yaml, ADR 1 T3, ADR 6): a port Ledger owns, in its own words.
 * `membersOf` answers the group's current members, in the order they joined, the owner first, each with its role; or
 * `undefined` when there is no such group. The adapter that answers it is Ledger's infrastructure over Groups' roster, so no
 * domain imports Groups.
 */
export interface IGroupMembers {
  membersOf(groupId: string): Promise<GroupMemberRole[] | undefined>;
  /**
   * Whether the account is, or has ever been, a member of the group (feature 9): a member who left keeps the statement of their
   * expenses, which the group's members still read. Answered over the same roster.
   */
  hasBeenMember(groupId: string, memberId: string): Promise<boolean>;
  /**
   * The balances that passed to the owner when members left the group, in the order they were made (request 20, ADR 15): every
   * balance Ledger reads takes each one off the leaver and puts it on the owner, so the leaver stands at 0 and the group still adds up
   * to 0. Answered over the same roster.
   */
  passedBalancesOf(groupId: string): Promise<PassedBalance[]>;
  /**
   * Whether the group is archived (feature 27, request 27): the group is read-only then, and a change in it is refused by the shared
   * kernel's GroupArchived. Answered over the same roster; a group that is not there answers `false`.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (feature 34, request 34): a suspended account starts no expense nor recurring expense, in any group, and
   * the recording is refused by the shared kernel's AccountSuspended. Answered over the same roster; an account that is not there answers `false`.
   */
  isSuspended(accountId: string): Promise<boolean>;
}

/** A balance that passed from a member who left a group to its owner, in the group's currency's hundredths (request 20). */
export interface PassedBalance {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}
