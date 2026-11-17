import { DomainEvent } from '@Architecture/Domain';

/** An account was opened: its id, published with the account in the same transaction (the outbox). */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string }> {}
