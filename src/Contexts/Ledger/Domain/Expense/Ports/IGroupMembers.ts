import { Id } from '@Architecture/Domain';

/**
 * The members of a group as Groups has them now, asked by Ledger in its own words (ADR 3): who may be in a split, and
 * who may read an expense or the balances of the group. In the order they joined, the earliest first; empty for a group
 * nobody is a member of, or that does not exist.
 */
export interface IGroupMembers {
  currentMembers(groupId: Id): Promise<Id[]>;
}
