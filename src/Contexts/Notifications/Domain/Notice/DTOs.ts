/** A notice as `GetMyNotices` answers it (request 17): `amount` is the member's share, `at` when it was made (ISO 8601). */
export interface NoticeView {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}

/** A notice as the store keeps it. */
export interface NoticeSnapshot {
  id: string;
  accountId: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}
