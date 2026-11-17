/** A member's share of an expense: whole units of the group's currency, the shares of a split adding up to its amount. */
export interface ShareSnapshot {
  memberId: string;
  amount: number;
}

/** The state of an expense as the store keeps it: what `Expense.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface ExpenseSnapshot {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  /** A day of the calendar, `YYYY-MM-DD`. */
  date: string;
  paidBy: string;
  /** The shares, in the order the split was given. */
  shares: ShareSnapshot[];
  /** The version the expense was read at: the store stores version + 1 on every save. */
  version: number;
}

/** What a member reads of an expense: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareSnapshot[];
  /** The version the expense is at: 1 when it is recorded, one more at each edit (request 6). */
  version: number;
}

/** What a member is owed (positive) or owes (negative) in a group, whole units: a read model (docs/adr/0005). */
export interface BalanceView {
  memberId: string;
  balance: number;
}
