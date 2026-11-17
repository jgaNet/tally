/**
 * A notice as its recipient reads it (request 17's `notice` resource, restated by request 18). `expenseId` is the expense of an
 * expense's notice, and absent from a reminder's; `amount` is the share, or what is still owed.
 */
export interface NoticeView {
  id: string;
  kind: 'expense' | 'reminder';
  groupId: string;
  expenseId?: string;
  amount: number;
  /** When it was made, ISO 8601 in UTC. */
  at: string;
}

/** The read side of notices: read models, never aggregates (QUERY-READ-MODELS). */
export interface INoticeQueries {
  /** The notices of `recipient`, the most recent first. */
  ofRecipient(recipient: string): Promise<NoticeView[]>;
}
