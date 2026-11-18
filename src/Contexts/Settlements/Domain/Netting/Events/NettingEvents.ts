import { DomainEvent } from '@Architecture/Domain';

/** Two people netted what they owe each other across their groups (request 32): who asked, with whom, the currency, the amount and the settlements made, in order. */
export class NettingRecordedEvent extends DomainEvent<{
  nettingId: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlementIds: string[];
}> {}
