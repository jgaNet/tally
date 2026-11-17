/**
 * A member's balance in a group, as Groups needs it to decide whether the member may leave (feature 9): a port Groups owns,
 * in its own words, answered by an adapter over Ledger's balances read model (`BalancesOfLedger`, in this context's
 * Infrastructure). Ledger's Domain is never imported; the balance is a plain number, what the member owes (negative) or is
 * owed (positive) in the group, 0 when Ledger counts nothing for them.
 */
export interface IMemberBalances {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
