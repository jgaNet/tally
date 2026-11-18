/** A member's share of a recurring expense split by exact amounts (request 7, request 23). */
export interface RecurringAmountView {
  memberId: string;
  amount: number;
}

/** A member's shares of a recurring expense split by shares (request 7, request 23). */
export interface RecurringSharesView {
  memberId: string;
  shares: number;
}

/**
 * What `GetRecurringExpense` answers: a recurring expense as it is stored, with the split as it was given, exactly one of
 * `splitBetween`, `splitExactly` or `splitByShares` (request 23). `next` is the day of the expense it records next.
 */
export interface RecurringExpenseView {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  splitBetween?: string[];
  splitExactly?: RecurringAmountView[];
  splitByShares?: RecurringSharesView[];
}

/** The read side of the recurring expenses: read models, never aggregates (QUERY-READ-MODELS). */
export interface IRecurringExpenseQueries {
  /** The recurring expense, if it is set up. Who may read it is the use case's to say. */
  recurringOf(id: string): Promise<RecurringExpenseView | undefined>;
  /** The recurring expenses of the group, the earliest set up first. */
  recurringsOf(groupId: string): Promise<RecurringExpenseView[]>;
}
