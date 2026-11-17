import { DomainEvent } from '@Architecture/Domain';

/** A notice was made for a member about an expense: the notice's id, the member it is theirs, and the expense it is about. */
export class NoticeIssuedEvent extends DomainEvent<{ noticeId: string; recipientId: string; expenseId: string }> {}
