/** A balance that passed to the owner when a member left the group (request 20), as Ledger reads it: the member who left, when, and the amount. */
export interface PassedBalance {
  id: string;
  at: string;
  memberId: string;
  amount: number;
}

/**
 * The balances that passed to owners when members left, as Ledger reads them for the audit (request 28): a port Ledger owns, in its own words
 * (CTX-CONTRACTS, ADR 25), answered by an adapter over Groups' read model (`PassedBalancesOfGroups`, in the wiring of this context). Groups keeps
 * each one, with the leave, in the same transaction. Ledger's Domain never imports Groups.
 */
export interface IPassedBalances {
  /** Every balance that passed in the group, the one of a member who left with nothing to pass included, in the order they passed. */
  passedOf(groupId: string): Promise<PassedBalance[]>;
}
