/** What a notice is about: an expense recorded with the recipient in its split (request 17). */
export type NoticeKind = 'expense';

/** A notice as the store keeps it: its identity, who it is for, what it is about, the recipient's share, when it was made, and its version. */
export interface INoticeSnapshot {
  _id: string;
  recipient: string;
  kind: NoticeKind;
  groupId: string;
  expenseId: string;
  amount: number;
  at: Date;
  version: number;
}

/** A member's part of an expense, as Notifications reads it from the fact Ledger publishes. */
export interface ExpenseSharePart {
  memberId: string;
  amount: number;
}
