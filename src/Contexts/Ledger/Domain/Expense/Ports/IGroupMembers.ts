import { Id } from '@Architecture/Domain';

/** A member's role in a group, as Groups has it: the owner made the group, every other member is a member. */
export type MemberRole = 'owner' | 'member';

/**
 * The members of a group as Groups has them now, asked by Ledger in its own words (ADR 3): who may be in a split, who may
 * read an expense or the balances of the group, and who may change an expense. `currentMembers` lists them in the order
 * they joined, the earliest first; empty for a group nobody is a member of, or that does not exist. `roleOf` answers
 * one account's role in the group, or null when it is not a member of it now. `hasBeenMember` answers whether an account
 * has ever been a member, so that a former member's statement is still read by the members (ADR 4).
 */
export interface IGroupMembers {
  currentMembers(groupId: Id): Promise<Id[]>;
  /** The groups this account is a member of now, in any currency and archived or not, for its spending insights (request 37); empty for none. */
  groupsOf(accountId: Id): Promise<Id[]>;
  roleOf(groupId: Id, accountId: Id): Promise<MemberRole | null>;
  hasBeenMember(groupId: Id, accountId: Id): Promise<boolean>;
  /**
   * What passed to each member when a member left the group, in Ledger's words (request 20): the owner's balance went up by
   * what the leaver owed or was owed, and the leaver's went down by it, so this adds up to 0 over the group. A member with
   * nothing passed is absent (0). Ledger counts it in every balance it reads.
   */
  balancesPassed(groupId: Id): Promise<Map<string, number>>;
  /** Whether the group is archived (request 27, ADR 20): a change in an archived group is refused by GroupArchived. */
  isArchived(groupId: Id): Promise<boolean>;
  /** Whether an administrator has suspended the account (request 34, ADR 25): a suspended account records no expense, in any group. */
  isSuspended(accountId: Id): Promise<boolean>;
  /** Of these accounts, the ones whose person deleted them (request 35, ADR 26): none is put in a new split; their balances stay. */
  deletedAmong(accountIds: readonly Id[]): Promise<Id[]>;
}
