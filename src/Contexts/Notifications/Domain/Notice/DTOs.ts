/** The kinds of a notice: an expense of the group concerns the person, a debt of theirs lasted, or a month passed a budget (request 24). */
export type NoticeKind = 'expense' | 'reminder' | 'budget';

/**
 * A notice as `GetMyNotices` answers it (request 17): `amount` is the member's share of an expense, what the member still owes for a
 * reminder (request 18), or what a month spends in a category for a budget (request 24). `expenseId` is named only by an expense's notice;
 * `category`, `month` and `budget` only by a budget's. `at` is when it was made (ISO 8601).
 */
export interface NoticeView {
  id: string;
  kind: NoticeKind;
  groupId: string;
  expenseId?: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}

/** A notice as the store keeps it. */
export interface NoticeSnapshot {
  id: string;
  accountId: string;
  kind: NoticeKind;
  groupId: string;
  expenseId?: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}
