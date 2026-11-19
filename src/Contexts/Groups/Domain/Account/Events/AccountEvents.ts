import { DomainEvent } from '@Architecture/Domain';

/** Someone signed up: the account, known by its id, its email and its name. */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; email: string; name: string }> {}

/** An administrator suspended an account, and when: every expense and settlement it starts is refused until it is reinstated (request 34). */
export class AccountSuspendedEvent extends DomainEvent<{ accountId: string; suspendedAt: string }> {}

/** An administrator reinstated a suspended account, and when (request 34). */
export class AccountReinstatedEvent extends DomainEvent<{ accountId: string; reinstatedAt: string }> {}
