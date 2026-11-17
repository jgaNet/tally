/**
 * The members of a group, as Settlements asks them (conventions/domain.yaml, ADR 9, the storm's `SettlementMembers`): a port
 * Settlements owns, in its own words, answered over Groups' roster. `membersOf` answers the group's current members' account
 * ids, in the order they joined, the earliest first; or `undefined` when there is no such group. `currencyOf` answers the
 * currency the group was created in (a code, EUR and the like), which a payment through the provider names (request 13), or
 * `undefined` when there is no such group. The adapter is Settlements' infrastructure over Groups' roster, so no domain imports Groups.
 */
export interface ISettlementMembers {
  membersOf(groupId: string): Promise<readonly string[] | undefined>;
  currencyOf(groupId: string): Promise<string | undefined>;
}
