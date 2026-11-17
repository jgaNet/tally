/**
 * A member's balance in a group, as Groups asks it (conventions/domain.yaml, ADR 1 T5, feature 9): a port Groups owns, in its
 * own words, answered when a member asks to leave. What the member owes or is owed in the group, in the group's currency's
 * hundredths; 0 when nothing is counted. The adapter that answers it is Groups' infrastructure over Ledger's balances read
 * model, so no domain imports Ledger.
 */
export interface IMemberBalances {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
