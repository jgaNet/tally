/**
 * A notice as its recipient reads it (request 17's `notice` resource, restated by requests 18 and 24). `expenseId` is the expense of an
 * expense's notice, and absent from the others; `amount` is the share, what is still owed, or what the month spends. A budget's notice
 * names its `category`, its `month` (YYYY-MM) and its `budget`.
 */
export interface NoticeView {
  id: string;
  kind: 'expense' | 'reminder' | 'budget';
  groupId: string;
  expenseId?: string;
  amount: number;
  /** When it was made, ISO 8601 in UTC. */
  at: string;
  category?: string;
  month?: string;
  budget?: number;
}

/** The read side of notices: read models, never aggregates (QUERY-READ-MODELS). */
export interface INoticeQueries {
  /** The notices of `recipient`, the most recent first. */
  ofRecipient(recipient: string): Promise<NoticeView[]>;
}
