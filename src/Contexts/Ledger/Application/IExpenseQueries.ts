/** One member's share, as `GetExpense` answers it. */
export interface ShareView {
  memberId: string;
  amount: number;
}

/** What `GetExpense` answers: an expense as it was recorded, its shares in the order of the split. */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  date: string;
  paidBy: string;
  shares: ShareView[];
}

/** The read side of the expenses: read models, never aggregates (QUERY-READ-MODELS). */
export interface IExpenseQueries {
  /** The expense, if it is recorded. Who may read it is the use case's to say (a member of its group). */
  expenseOf(id: string): Promise<ExpenseView | undefined>;
}
