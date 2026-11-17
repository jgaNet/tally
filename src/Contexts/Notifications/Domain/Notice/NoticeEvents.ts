import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was made for a member of an expense's split (request 17, ADR 14): recorded by the notice's birth and published with
 * it. Nothing reacts to it yet; a later request may read it (the reminders of request 19).
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  memberId: string;
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}> {}
