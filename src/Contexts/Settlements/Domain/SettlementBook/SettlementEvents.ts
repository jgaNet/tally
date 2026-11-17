import { DomainEvent } from '@Architecture/Domain';

/**
 * A settlement was recorded in cash by its payee (request 12): `payer` paid `payee` `amount`. Recorded by `SettlementBook.recordCash`
 * and published after the book is saved. Nothing reacts to it yet, so it is not an integration event.
 */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}
