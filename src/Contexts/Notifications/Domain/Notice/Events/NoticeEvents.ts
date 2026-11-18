import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was issued to a member: its id, who it is for, the group it is about, what it is about (its expense, for an
 * expense's notice; none for a reminder or a budget's), the amount, and when. A budget's notice names its category, its month
 * and its budget (request 24).
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  recipient: string;
  kind: string;
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
  category?: string;
  month?: string;
  budget?: number;
}> {}
