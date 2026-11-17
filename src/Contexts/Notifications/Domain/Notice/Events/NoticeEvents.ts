import { DomainEvent } from '@Architecture/Domain';

/**
 * A person was told of an expense that concerns them (request 17, docs/adr/0017), or reminded of a debt that lasted (request 18,
 * docs/adr/0018, where `expenseId` is absent). Recorded by `Notice.issue()` and `Notice.remind()`.
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  accountId: string;
  groupId: string;
  expenseId?: string;
  amount: number;
}> {}
