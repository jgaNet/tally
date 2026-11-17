/**
 * What a member of a group owes or is owed in it, as Groups needs it to decide a leave (conventions/domain.yaml, the
 * MemberBalances link; docs/adr/0009). Groups owns the port, in its own words; Ledger answers it through an adapter in
 * Groups' Infrastructure, over Ledger's read model. It is asked when a leave is decided, inside its transaction.
 */
export interface IMemberBalances {
  /** The balance of the account in the group: what it is owed (positive) or owes (negative), 0 when nothing is recorded for it. */
  balanceOf(groupId: string, accountId: string): Promise<number>;
}
