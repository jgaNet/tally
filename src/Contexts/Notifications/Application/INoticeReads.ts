import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';

/** A notice as a person reads it (requests 17, 18 and 24): its kind, the group, the expense of an expense's notice (none for a reminder), the amount, and when it was made. */
export interface NoticeView {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly groupId: string;
  readonly expenseId?: string;
  /** A budget's notice (request 24): its category, the month passed, and the budget; `amount` is what the month spends. */
  readonly category?: string;
  readonly month?: string;
  readonly budget?: number;
  readonly amount: number;
  readonly at: string;
}

/** The read model of the notices: a person's own, the most recent first. Nothing else is read from it. */
export interface INoticeReads {
  listFor(recipientId: string): Promise<NoticeView[]>;
}
