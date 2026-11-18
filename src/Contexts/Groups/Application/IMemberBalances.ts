/**
 * A member's balance in a group, as Groups asks it (conventions/domain.yaml, ADR 1 T5, feature 9): a port Groups owns, in its
 * own words, answered when a member asks to leave. What the member owes or is owed in the group, in the group's currency's
 * hundredths; 0 when nothing is counted. The adapter that answers it is Groups' infrastructure over Ledger's balances read
 * model, so no domain imports Ledger.
 */
export interface IMemberBalances {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}

/**
 * Whether a member has a payment waiting at the provider in a group (request 20, ADR 15): a payment they pay or receive through the
 * provider, pending or refunding, which a member may not leave while it waits. Groups asks it when a member asks to leave; the
 * adapter is Groups' infrastructure over Settlements' read model, so no domain imports Settlements.
 */
export interface IWaitingPayments {
  hasWaitingPayment(groupId: string, memberId: string): Promise<boolean>;
  /**
   * Whether an account pays or receives a payment through the provider that waits, in any group (feature 35, request 35): pending, refunding
   * or contested. A deletion is refused while one does. The adapter is the same read model, over every group.
   */
  hasPaymentWaitingOf(accountId: string): Promise<boolean>;
}
