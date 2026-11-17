import { DomainEvent } from '@Architecture/Domain';

/** A person set the payout account they are paid on: the provider's id of it, which the provider knew. */
export class PayoutAccountSetEvent extends DomainEvent<{
  owner: string;
  accountId: string;
}> {}
