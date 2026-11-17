/**
 * A notice as `GetMyNotices` answers it (request 17): `amount` is the member's share of an expense, or what the member still owes
 * for a reminder (request 18); `expenseId` is named only by an expense's notice. `at` is when it was made (ISO 8601).
 */
export interface NoticeView {
  id: string;
  kind: 'expense' | 'reminder';
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
}

/** A notice as the store keeps it. */
export interface NoticeSnapshot {
  id: string;
  accountId: string;
  kind: 'expense' | 'reminder';
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
}
