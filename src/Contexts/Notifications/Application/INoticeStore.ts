import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/** A notice as a member reads it (request 17): `kind` is `expense`, `amount` the member's share, `at` when it was made. */
export interface NoticeView {
  id: string;
  kind: 'expense';
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}

/**
 * The store of the notices, which the reaction writes and the query reads. `insert` keeps every notice of one expense in one
 * transaction, or none. `noticesOf` answers a member's notices, the most recent first (the store sorts, the query does not).
 */
export interface INoticeStore {
  insert(notices: Notice[]): Promise<void>;
  noticesOf(memberId: string): Promise<NoticeView[]>;
}
