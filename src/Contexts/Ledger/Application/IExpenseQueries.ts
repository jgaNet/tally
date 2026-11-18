import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';

/** One member's share, as `GetExpense` answers it. */
export interface ShareView {
  memberId: string;
  amount: number;
}

/** What an expense paid in another currency was paid as, as `GetExpense` answers it (request 21): the rate is the string given. */
export interface OriginalView {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * What `GetExpense` answers: an expense as it is stored, how it was split (`equal`, `exact` or `shares`, request 7), its
 * shares in the order of the split, and the version it is at (1 when it is recorded, one more at each edit). Its `amount` is
 * in the group's currency; an expense paid in another currency also has `original`, what was paid (request 21).
 */
export interface ExpenseView {
  id: string;
  groupId: string;
  description: string;
  amount: number;
  original?: OriginalView;
  date: string;
  paidBy: string;
  splitKind: 'equal' | 'exact' | 'shares';
  shares: ShareView[];
  /** What it was for (request 24). */
  category: ExpenseCategory;
  version: number;
}

/** What `GetGroupBalances` answers for one member: what the group owes them (positive) or they owe (negative). */
export interface BalanceView {
  memberId: string;
  balance: number;
}

/**
 * An expense a member paid or is in the split of, as a statement reads it (request 8, request 29): what the member paid for it, their
 * share of it, and when it was recorded (the instant the statement puts it among the settlements of its day by).
 */
export interface ExpenseLineView {
  expenseId: string;
  recordedAt: string;
  date: string;
  description: string;
  paid: number;
  share: number;
}

/** The read side of the expenses: read models, never aggregates (QUERY-READ-MODELS). */
export interface IExpenseQueries extends IBalanceQueries {
  /**
   * Every expense of the group that is not deleted, each as `expenseOf` reads it, the latest date first and, on the same
   * date, the most recently recorded first (request 8). An edit does not change when an expense was recorded.
   */
  expensesOf(groupId: string): Promise<ExpenseView[]>;
  /**
   * The expenses of the group that are not deleted and that the member paid or is in the split of, the earliest date first and, on the
   * same date, the earliest recorded first (by its instant, then by its order of recording): the order a statement lists them in (request
   * 29). Nothing is computed here; the statement's balance is read from these lines and the settlements.
   */
  expenseLinesOf(groupId: string, memberId: string): Promise<ExpenseLineView[]>;
  /**
   * Whether the member paid an expense of the group that is not deleted, or is in its split: a member who left the group
   * keeps their statement readable for as long as an expense of theirs is recorded (request 9).
   */
  isInvolved(groupId: string, memberId: string): Promise<boolean>;
  /** The expense, if it is recorded. Who may read it is the use case's to say (a member of its group). */
  expenseOf(id: string): Promise<ExpenseView | undefined>;
  /**
   * What a month spends in each category of the group (request 24): the sum of the amounts of its expenses, deleted ones left out, whose
   * date is in `month` (`YYYY-MM`, UTC). A category that spends nothing is not in it.
   */
  spentByCategory(groupId: string, month: string): Promise<ReadonlyMap<ExpenseCategory, number>>;
}
