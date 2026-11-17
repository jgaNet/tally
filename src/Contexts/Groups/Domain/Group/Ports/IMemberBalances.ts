/**
 * Groups' own port onto Ledger: the balance a member has in a group, as Groups needs it to decide whether the member
 * may leave. Groups asks it when it decides, in its own words; the adapter answers over Ledger's balances read model
 * (ADR 5). No domain imports Ledger.
 */
export interface IMemberBalances {
  /** What the member owes (a negative balance) or is owed (a positive one) in the group; 0 when no expense counts it. */
  balanceOf(groupId: string, memberId: string): Promise<number>;
}
