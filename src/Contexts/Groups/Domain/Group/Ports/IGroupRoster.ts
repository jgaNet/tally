/**
 * The roster of groups, the read-model port Groups gives other contexts (conventions/domain.yaml, ADR 6): who is a member of
 * a group now, in the order they joined, the owner first. It answers the facts another context needs in its own words and
 * never an aggregate; a group that is not there answers `undefined`, which is the same answer for everyone. Ledger reads it
 * through an adapter of its own, when it decides who may be in a split.
 */
export interface IGroupRoster {
  membersOf(groupId: string): Promise<string[] | undefined>;
}
