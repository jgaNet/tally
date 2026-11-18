import { DomainEvent } from '@Architecture/Domain';

/**
 * A netting was made (request 32, docs/adr/0032): what two members owed each other across their groups, netted in one currency, as
 * settlements that count at once. Recorded by `Netting.create()`, and published once the netting and its settlements are stored.
 */
export class NettingRecordedEvent extends DomainEvent<{
  nettingId: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
}> {}
