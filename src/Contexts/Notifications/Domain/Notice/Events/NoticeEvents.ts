import { DomainEvent } from '@Architecture/Domain';

/** A notice was made for a member: its id, its kind, who it is for, the expense it is about (null for a reminder), the amount, and when it was made. */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  kind: 'expense' | 'reminder';
  memberId: string;
  groupId: string;
  expenseId: string | null;
  amount: number;
  issuedAt: string;
}> {}
