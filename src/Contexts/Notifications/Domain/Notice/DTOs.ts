/** What a notice is about: an expense recorded with the recipient in its split (request 17), or a debt that lasted (request 18). */
export type NoticeKind = 'expense' | 'reminder';

/** A notice as the store keeps it: its identity, who it is for, what it is about, the amount, when it was made, and its version. */
export interface INoticeSnapshot {
  _id: string;
  recipient: string;
  kind: NoticeKind;
  groupId: string;
  /** The expense of an expense's notice; null for a reminder, which has none. */
  expenseId: string | null;
  /** An expense's notice: the recipient's share. A reminder: what the recipient still owes. */
  amount: number;
  at: Date;
  version: number;
}

/** A member's part of an expense, as Notifications reads it from the fact Ledger publishes. */
export interface ExpenseSharePart {
  memberId: string;
  amount: number;
}
