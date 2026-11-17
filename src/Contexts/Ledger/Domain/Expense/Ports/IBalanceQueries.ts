/** One member's balance in a group, as the expenses recorded so far count it: positive when owed, negative when owing. */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/**
 * The read side of balances: a read model of Ledger's own facts, written in the transaction of each expense that counts
 * (ADR 1, T4), and the settlements paid, which count through a port Ledger owns (ADR 8). It never aggregates a running
 * balance into an aggregate (QUERY-READ-MODELS).
 */
export interface IBalanceQueries {
  /**
   * The balances of the members that any expense or paid settlement of the group counts, each as they count it. A member
   * nothing counts is not listed; the handler gives it 0.
   */
  balancesOf(groupId: string): Promise<MemberBalance[]>;
}
