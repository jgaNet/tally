/**
 * The roster of groups, the read-model port Groups gives other contexts (conventions/domain.yaml, ADR 6): who is a member of
 * a group now, in the order they joined, the owner first, and the role each has in it. It answers the facts another context
 * needs in its own words and never an aggregate; a group that is not there answers `undefined`, which is the same answer for
 * everyone. Ledger reads it through an adapter of its own, when it decides who may be in a split and who may change an expense.
 */
export interface IGroupRoster {
  membersOf(groupId: string): Promise<RosterMember[] | undefined>;
  /** Whether the account is, or has been, a member of the group: a member who left keeps their statement (feature 9). */
  hasBeenMember(groupId: string, accountId: string): Promise<boolean>;
  /** The currency the group was created in, as a code (EUR, USD, ...); a group that is not there answers `undefined` (feature 13). */
  currencyOf(groupId: string): Promise<string | undefined>;
  /** The ids of every group there is, the earliest made first: what a sweep over all the groups reads (feature 18). */
  groupIds(): Promise<string[]>;
}

/** A member of a group as the roster answers it: the account, and its role in the group (the owner, or a member). */
export interface RosterMember {
  readonly memberId: string;
  readonly role: 'owner' | 'member';
}
