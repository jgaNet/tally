import { DomainEvent } from '@Architecture/Domain';

/**
 * A notice was made for a member of an expense's split (request 17, ADR 14): recorded by the notice's birth and published with
 * it. Nothing reacts to it yet; a later request may read it (the reminders of request 18 make theirs, `kind` `reminder`).
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  memberId: string;
  kind: 'expense' | 'reminder' | 'budget';
  groupId: string;
  /** The expense an `expense` notice is about; a reminder has none. */
  expenseId?: string;
  /** What a `budget` notice is about (request 24): the category, the month (`YYYY-MM`) and the budget it passed. */
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}> {}
