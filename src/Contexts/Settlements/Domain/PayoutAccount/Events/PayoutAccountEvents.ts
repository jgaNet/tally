import { DomainEvent } from '@Architecture/Domain';

/** A member's payout account was set: the member it is for, and the provider's id of the account, which the provider knows. */
export class PayoutAccountSetEvent extends DomainEvent<{ owner: string; accountId: string }> {}
