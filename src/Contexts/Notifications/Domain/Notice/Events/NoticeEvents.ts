import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was issued to a member: its id, who it is for, the group it is about, what it is about (its expense, for an
 * expense's notice; none for a reminder), the amount, and when.
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  recipient: string;
  kind: string;
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
}> {}
