/**
 * Ledger's own port onto Groups: the currency a group counts in, which Ledger needs to convert an expense paid in another
 * currency (request 21). Ledger asks it when it decides, in its own words; the adapter answers over Groups' read model
 * (ADR 12, beside `IGroupMembers`). The currency never changes, so the answer is the one the group was founded with.
 */
export interface IGroupCurrency {
  /**
   * The currency of the group, as one of Tally's currencies, when `askedBy` is one of its current members; null otherwise,
   * as if the group did not exist.
   */
  currencyOf(groupId: string, askedBy: string): Promise<string | null>;
}
