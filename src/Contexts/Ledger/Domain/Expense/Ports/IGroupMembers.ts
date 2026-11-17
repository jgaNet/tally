import { Id } from '@Architecture/Domain';

/** A member's role in a group, as Groups has it: the owner made the group, every other member is a member. */
export type MemberRole = 'owner' | 'member';

/**
 * The members of a group as Groups has them now, asked by Ledger in its own words (ADR 3): who may be in a split, who may
 * read an expense or the balances of the group, and who may change an expense. `currentMembers` lists them in the order
 * they joined, the earliest first; empty for a group nobody is a member of, or that does not exist. `roleOf` answers
 * one account's role in the group, or null when it is not a member of it.
 */
export interface IGroupMembers {
  currentMembers(groupId: Id): Promise<Id[]>;
  roleOf(groupId: Id, accountId: Id): Promise<MemberRole | null>;
}
