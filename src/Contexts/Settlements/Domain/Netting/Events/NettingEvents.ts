import { DomainEvent } from '@Architecture/Domain';

/**
 * Two members netted what they owe each other across their groups (request 32): who asked, with whom, in which currency, the
 * amount netted, and the settlements made for it, in the order they were made.
 */
export class NettingRecordedEvent extends DomainEvent<{
  nettingId: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlementIds: string[];
  nettedAt: string;
}> {}
