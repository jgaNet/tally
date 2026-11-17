import { DomainEvent } from '@Architecture/Domain';

/** A settlement was recorded in a group's book: it exists under the id it was born with, paid by the payer to the payee. */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}
