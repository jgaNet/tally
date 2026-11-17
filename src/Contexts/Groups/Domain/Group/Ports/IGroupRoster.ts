/**
 * The roster of groups, the read-model port Groups gives other contexts (conventions/domain.yaml, ADR 6): who is a member of
 * a group now, in the order they joined, the owner first, and the role each has in it. It answers the facts another context
 * needs in its own words and never an aggregate; a group that is not there answers `undefined`, which is the same answer for
 * everyone. Ledger reads it through an adapter of its own, when it decides who may be in a split and who may change an expense.
 */
export interface IGroupRoster {
  membersOf(groupId: string): Promise<RosterMember[] | undefined>;
}

/** A member of a group as the roster answers it: the account, and its role in the group (the owner, or a member). */
export interface RosterMember {
  readonly memberId: string;
  readonly role: 'owner' | 'member';
}
