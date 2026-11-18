/**
 * The currency a group was created in, as Ledger asks it (conventions/domain.yaml, request 21, the storm's GroupCurrency): a port
 * Ledger owns, in its own words, beside `IGroupMembers`. `currencyOf` answers the group's code (EUR, USD, ...), or `undefined` when
 * there is no such group. It never changes, so a read at the time of the decision is the same as a copy. The adapter over Groups'
 * roster is Ledger's infrastructure, so no domain imports Groups.
 */
export interface IGroupCurrency {
  currencyOf(groupId: string): Promise<string | undefined>;
}
