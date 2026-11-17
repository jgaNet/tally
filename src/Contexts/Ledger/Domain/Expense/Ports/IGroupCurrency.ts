/**
 * The group's currency, as Ledger needs it to convert an expense paid in another currency (request 21, docs/adr/0020). Ledger owns the
 * port; Groups answers it through an adapter in Ledger's Infrastructure, over Groups' read model, as it answers GroupMembers.
 */
export interface IGroupCurrency {
  /**
   * The currency the group is in, when the caller is one of its members: `undefined` otherwise, as if the group did not exist. The
   * currency never changes, so a read is as good as the one the expense was made in.
   */
  currencyOf(callerId: string, groupId: string): Promise<string | undefined>;
}
