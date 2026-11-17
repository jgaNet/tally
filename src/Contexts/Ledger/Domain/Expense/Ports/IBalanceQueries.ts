/** One member's balance in a group, as the expenses recorded so far count it: positive when owed, negative when owing. */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/**
 * The read side of balances: a read model of Ledger's own facts, written in the transaction of each expense that counts
 * (ADR 1, T4). It never aggregates a running balance into an aggregate (QUERY-READ-MODELS).
 */
export interface IBalanceQueries {
  /**
   * The balances of the members that any expense of the group counts, each as the expenses count it. A member no
   * expense counts is not listed; the handler gives it 0.
   */
  balancesOf(groupId: string): Promise<MemberBalance[]>;
}
