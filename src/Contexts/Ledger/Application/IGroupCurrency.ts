/**
 * The currency of a group, as Ledger needs it to decide an expense paid in another currency (request 21): a port Ledger owns, in its
 * own words (ADR 5, ADR 18), answered by an adapter over Groups' read model (`GroupCurrencyOfGroups`, in the wiring of this context).
 * The currency is fixed when a group is created, so it never changes once an expense is recorded in it.
 */
export interface IGroupCurrency {
  /**
   * The group's currency, if `askedBy` is one of its members; `undefined` when it is not, or the group is not there: to anyone else a
   * group does not exist.
   */
  currencyOf(groupId: string, askedBy: string): Promise<string | undefined>;
}
