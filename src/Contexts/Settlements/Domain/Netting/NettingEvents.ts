import { DomainEvent } from '@Architecture/Domain';

/**
 * A netting was made (request 32): `by` and `with` netted `amount` in `currency`, as the settlements `settlementIds`, in the order they were
 * made. Recorded by `Netting.create` and published once it is saved, in the same transaction as the settlements it made. Nothing reacts to
 * it yet, so it is not an integration event.
 */
export class NettingRecordedEvent extends DomainEvent<{
  nettingId: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlementIds: string[];
}> {}
