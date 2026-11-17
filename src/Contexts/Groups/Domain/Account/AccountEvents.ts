import { DomainEvent } from '@Architecture/Domain';

/**
 * An account was registered. Recorded by the account's creation and published after its save; nothing reacts to it
 * yet, so it is not an integration event (ADR 2 says when it becomes one).
 */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; registeredAt: Date }> {}
