import { DomainEvent } from '@Architecture/Domain';

/** A notice was made for a member: its id, who it is for, the expense and group it is about, the member's share, and when it was made. */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  memberId: string;
  groupId: string;
  expenseId: string;
  amount: number;
  issuedAt: string;
}> {}
