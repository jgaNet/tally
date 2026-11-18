import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was made for a member: its id, its kind, who it is for, the expense it is about (null for a reminder and a
 * budget), the amount, when it was made, and for a budget's notice its category, month and budget (null otherwise).
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  kind: 'expense' | 'reminder' | 'budget';
  memberId: string;
  groupId: string;
  expenseId: string | null;
  amount: number;
  issuedAt: string;
  category: string | null;
  month: string | null;
  budget: number | null;
}> {}
