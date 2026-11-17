import { DomainEvent } from '@Architecture/Domain';

/**
 * A member's payout account was set (request 16): `ownerId` is paid by the provider on `accountId`. Recorded by `PayoutAccount.create` and
 * `replaceWith`, published after the account is saved. Nothing reacts to it yet, so it is not an integration event.
 */
export class PayoutAccountSetEvent extends DomainEvent<{ ownerId: string; accountId: string }> {}
