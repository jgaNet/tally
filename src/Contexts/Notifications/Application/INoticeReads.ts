import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';

/** A notice as a person reads it (requests 17 and 18): its kind, the group, the expense of an expense's notice (none for a reminder), the amount, and when it was made. */
export interface NoticeView {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly groupId: string;
  readonly expenseId?: string;
  readonly amount: number;
  readonly at: string;
}

/** The read model of the notices: a person's own, the most recent first. Nothing else is read from it. */
export interface INoticeReads {
  listFor(recipientId: string): Promise<NoticeView[]>;
}
