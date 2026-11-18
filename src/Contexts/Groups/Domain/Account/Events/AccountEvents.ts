import { DomainEvent } from '@Architecture/Domain';

/** An account was opened: its id, published with the account in the same transaction (the outbox). */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string }> {}

/** An account was suspended by an administrator, and when (request 34): published with the account in the same transaction. */
export class AccountSuspendedEvent extends DomainEvent<{ accountId: string; suspendedAt: string }> {}

/** An account was reinstated by an administrator, and when (request 34): published with the account in the same transaction. */
export class AccountReinstatedEvent extends DomainEvent<{ accountId: string; reinstatedAt: string }> {}

/** An account was deleted by its own person, and when (request 35): its name and email erased, its id kept, published with the account in the same transaction. */
export class AccountDeletedEvent extends DomainEvent<{ accountId: string; deletedAt: string }> {}
