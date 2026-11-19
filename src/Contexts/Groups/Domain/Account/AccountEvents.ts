import { DomainEvent } from '@Architecture/Domain';

/**
 * An account was registered. Recorded by the account's creation and published after its save; nothing reacts to it
 * yet, so it is not an integration event (ADR 2 says when it becomes one).
 */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; registeredAt: Date }> {}

/**
 * An administrator suspended an account (request 34). Recorded by `Account.suspend()` and published after its save; nothing reacts to it
 * yet, since every change a suspension refuses is asked of Groups through its ports (ADR 32), so it is not an integration event.
 */
export class AccountSuspendedEvent extends DomainEvent<{ accountId: string; suspendedAt: Date }> {}

/**
 * An administrator reinstated a suspended account (request 34). Recorded by `Account.reinstate()` and published after its save; not an
 * integration event, for the same reason as `AccountSuspended`.
 */
export class AccountReinstatedEvent extends DomainEvent<{ accountId: string; reinstatedAt: Date }> {}

/**
 * A person deleted their account (request 35). Recorded by `Account.delete()` and published after its save; nothing reacts to it yet: every context
 * refuses a deleted account through its port to Groups (ADR 33), so it is not an integration event.
 */
export class AccountDeletedEvent extends DomainEvent<{ accountId: string; deletedAt: Date }> {}
