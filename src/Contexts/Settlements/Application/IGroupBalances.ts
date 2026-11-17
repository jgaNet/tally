/**
 * The balances of a group, as Settlements needs them to suggest the transfers that settle it (request 11): a port Settlements
 * owns, in its own words, answered by an adapter over Ledger's balances read model (`GroupBalancesOfLedger`, in this context's
 * Infrastructure). Ledger's Domain is never imported by the Application; a balance is a plain number, what a member owes
 * (negative) or is owed (positive), and a member not in the map has 0.
 */
export interface IGroupBalances {
  /** The balance of every member the group's expenses have counted, in no order; one state of the group, read in one statement. */
  balancesOf(groupId: string): Promise<ReadonlyMap<string, number>>;
}
