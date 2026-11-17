/** One member's share, as `GetExpense` answers it. */
export interface ShareView {
  memberId: string;
  amount: number;
}

/**
 * What `GetExpense` answers: an expense as it is stored, its shares in the order of the split, and the version it is at (1
 * when it is recorded, one more at each edit).
 */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareView[];
  version: number;
}

/** What `GetGroupBalances` answers for one member: what the group owes them (positive) or they owe (negative). */
export interface BalanceView {
  memberId: string;
  balance: number;
}

/** The read side of the expenses: read models, never aggregates (QUERY-READ-MODELS). */
export interface IExpenseQueries {
  /** The expense, if it is recorded. Who may read it is the use case's to say (a member of its group). */
  expenseOf(id: string): Promise<ExpenseView | undefined>;
  /**
   * The balance of every member the group's expenses have counted, in no order. A member not in the map has 0. The
   * whole map is read in one statement, so it is one state of the group, never half of an expense.
   */
  balancesOf(groupId: string): Promise<ReadonlyMap<string, number>>;
}
