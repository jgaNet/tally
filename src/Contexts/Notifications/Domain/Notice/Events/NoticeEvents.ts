import { DomainEvent } from '@Architecture/Domain';

/** A person was told of an expense that concerns them (request 17, docs/adr/0017). Recorded by `Notice.issue()`. */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  accountId: string;
  groupId: string;
  expenseId: string;
  amount: number;
}> {}
