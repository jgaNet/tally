import { DomainEvent } from '@Architecture/Domain';

/** A notice was issued to a member: its id, who it is for, the expense and group it is about, their share, and when. */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  recipient: string;
  kind: string;
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}> {}
