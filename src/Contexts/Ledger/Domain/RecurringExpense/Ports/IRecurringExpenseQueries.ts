import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * What a member reads of a recurring expense: as it is now, with the split as it was given (one of the three keys) and `next`,
 * the day of the next expense it will record, and the category of the expenses it records (request 24).
 */
export interface RecurringExpenseView {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  category: Category;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

/** The read side of recurring expenses: read models, never aggregates (QUERY-READ-MODELS). Membership is not asked here. */
export interface IRecurringExpenseQueries {
  /** The recurring expense with this id, or null when there is none. */
  findRecurring(id: string): Promise<RecurringExpenseView | null>;
  /** The recurring expenses of a group, the earliest set up first. */
  listGroupRecurring(groupId: string): Promise<RecurringExpenseView[]>;
}
