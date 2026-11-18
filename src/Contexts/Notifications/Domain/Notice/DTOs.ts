/** What a notice is about: an expense recorded with the recipient in its split (request 17), a debt that lasted (request 18), or a month's spending that passed a budget (request 24). */
export type NoticeKind = 'expense' | 'reminder' | 'budget';

/** What a budget's notice says of its passing (request 24): the category, the month (YYYY-MM), and the budget it passed. */
export interface BudgetPassingPart {
  category: string;
  month: string;
  budget: number;
}

/** A notice as the store keeps it: its identity, who it is for, what it is about, the amount, when it was made, and its version. */
export interface INoticeSnapshot {
  _id: string;
  recipient: string;
  kind: NoticeKind;
  groupId: string;
  /** The expense of an expense's notice; null for a reminder and a budget's, which have none. */
  expenseId: string | null;
  /** An expense's notice: the recipient's share. A reminder: what the recipient still owes. A budget's: what the month spends. */
  amount: number;
  /** A budget's notice: its category, month and budget; null for the other kinds. */
  passing: BudgetPassingPart | null;
  at: Date;
  version: number;
}

/** A member's part of an expense, as Notifications reads it from the fact Ledger publishes. */
export interface ExpenseSharePart {
  memberId: string;
  amount: number;
}
