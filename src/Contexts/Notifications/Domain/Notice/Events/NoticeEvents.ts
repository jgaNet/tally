import { DomainEvent } from '@Architecture/Domain';

/**
 * A person was told of an expense that concerns them (request 17, docs/adr/0017), reminded of a debt that lasted (request 18,
 * docs/adr/0018, where `expenseId` is absent), or told that a month passed a budget (request 24, docs/adr/0023, where `expenseId` is
 * absent and `category`, `month` and `budget` are named). Recorded by `Notice.issue()`, `Notice.remind()` and `Notice.issueBudget()`.
 */
export class NoticeIssuedEvent extends DomainEvent<{
  noticeId: string;
  accountId: string;
  groupId: string;
  expenseId?: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
}> {}
