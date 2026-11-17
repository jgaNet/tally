import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was made for a member: the notice's id, the member it is theirs, its kind, and the expense it is about (none for a
 * reminder).
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  recipientId: string;
  kind: 'expense' | 'reminder';
  expenseId: string | null;
}> {}
