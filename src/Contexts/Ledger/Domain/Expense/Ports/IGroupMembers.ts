/** A member of a group as Ledger needs it: the account, and its role in the group (docs/adr/0006). */
export interface GroupMember {
  memberId: string;
  role: 'owner' | 'member';
}

/**
 * Who may be in a split, as Ledger needs it (ADR 1 T3, docs/adr/0004): the group's current members, answered over Groups'
 * read model when Ledger decides. Ledger owns the port; Groups answers it through an adapter in Ledger's Infrastructure.
 * The roles are asked too: the group's owner may change an expense its payer made (request 6, docs/adr/0006).
 */
export interface IGroupMembers {
  /**
   * The current members of the group, in the order they joined, with their roles, when the caller is one of them:
   * `undefined` otherwise, as if the group did not exist.
   */
  membersOf(callerId: string, groupId: string): Promise<GroupMember[] | undefined>;
  /**
   * Whether the account is, or has been, a member of the group, current or former (docs/adr/0009): a former member's statement
   * stays readable by the group's members. A read asks the caller's membership first, through `membersOf`.
   */
  hasBeenMember(groupId: string, memberId: string): Promise<boolean>;
  /**
   * What the leaves of the group passed to its owner (request 20, docs/adr/0019): the owner, and each member who left or joined again
   * after leaving, with what its leaves passed and whether it is a current member. Undefined for a group that does not exist.
   * The balances read it: each such member's balance is less what passed, and the owner carries what passed.
   */
  passedBalancesOf(groupId: string): Promise<PassedBalances | undefined>;
  /**
   * The ids of the group's current members, in the order they joined, for a background job that acts for the group and has no
   * caller (request 23, docs/adr/0022): a recurring expense ends when its payer or a member of its split is not among them. An
   * empty list for a group that does not exist.
   */
  currentMemberIds(groupId: string): Promise<string[]>;
  /**
   * The ids of the groups the account is a member of now, the most recently created first, for the spending insights (request 37,
   * docs/adr/0037): a group it left is not among them. Each group's currency is asked through GroupCurrency. Empty for an account in none.
   */
  currentGroupIdsOf(accountId: string): Promise<string[]>;
  /**
   * Whether the group is archived (request 27, docs/adr/0026): nothing in it changes any more, so an expense, a budget, a template, a
   * receipt or a recurring expense is refused by GroupArchived. Groups answers it; a change asks the caller's membership first, through
   * `membersOf`.
   */
  isArchived(groupId: string): Promise<boolean>;
  /**
   * Whether the account is suspended (request 34, docs/adr/0034): an administrator suspended it, and it starts no expense, recurring expense
   * while it is. Groups answers it; a change asks the caller's membership first, through `membersOf`.
   */
  isSuspended(accountId: string): Promise<boolean>;
  /**
   * Whether the account was deleted (request 35, docs/adr/0035): a deleted account stays a member, with its balance, and is in no new split,
   * starts no recurring expense and is told of no budget. Groups answers it.
   */
  isDeleted(accountId: string): Promise<boolean>;
}

/** A member whose leaves passed a balance to the owner, as Ledger's balances count it (docs/adr/0019). */
export interface PassedMember {
  memberId: string;
  passed: number;
  current: boolean;
}

/** The owner of a group, and what its members' leaves passed to the owner (docs/adr/0019). */
export interface PassedBalances {
  ownerId: string;
  members: PassedMember[];
}
