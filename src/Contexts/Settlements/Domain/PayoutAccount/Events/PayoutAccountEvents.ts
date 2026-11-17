import { DomainEvent } from '@Architecture/Domain';

/**
 * A person set its payout account: the provider knows it, and it is the account the person is paid on (request 16, docs/adr/0016).
 * Recorded by `PayoutAccount.set()`, and published once the account is stored.
 */
export class PayoutAccountSetEvent extends DomainEvent<{ accountId: string; providerAccountId: string }> {}
