/**
 * Settlements' port to Ledger, which Settlements owns (ADR 6): the balance a member has in a group, as Ledger keeps it. An
 * integer, 0 when nothing is recorded for the member. Answered by an adapter over Ledger's balances read model, and read by
 * the query that suggests the settlements.
 */
export interface IGroupBalances {
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
