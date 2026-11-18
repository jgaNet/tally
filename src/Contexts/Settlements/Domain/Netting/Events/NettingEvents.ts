import { DomainEvent } from '@Architecture/Domain';

/**
 * A netting was recorded: two people netted what they owe each other across their groups (request 32). It exists under the id it was
 * born with, from its two people, in the currency, for the amount, with its settlements in the order they were made.
 */
export class NettingRecordedEvent extends DomainEvent<{
  nettingId: string;
  by: string;
  withAccount: string;
  currency: string;
  amount: number;
  settlementIds: string[];
}> {}
