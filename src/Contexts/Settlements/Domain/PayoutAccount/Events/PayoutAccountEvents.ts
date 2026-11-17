import { DomainEvent } from '@Architecture/Domain';

/** A person's payout account was set, or replaced: its id, the person, and the provider's id of the account (request 16). */
export class PayoutAccountSetEvent extends DomainEvent<{
  payoutAccountId: string;
  owner: string;
  accountId: string;
}> {}
