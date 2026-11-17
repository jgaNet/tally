import { DomainEvent } from '@Architecture/Domain';

/**
 * A cash settlement was recorded by its payee (request 12, docs/adr/0013). Recorded by `SettlementBook.recordCash()`, and
 * published once the book is stored. No integration event carries it yet: no other context reacts to it in this request.
 */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}
