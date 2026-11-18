import { DomainEvent } from '@Architecture/Domain';

/** Someone signed up: the account exists, under the id it was born with. */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; name: string }> {}

/** An administrator suspended the account at `at`: nothing it starts is done until it is reinstated (request 34). */
export class AccountSuspendedEvent extends DomainEvent<{ accountId: string; at: string }> {}

/** An administrator reinstated the account at `at`: what it starts is done again (request 34). */
export class AccountReinstatedEvent extends DomainEvent<{ accountId: string; at: string }> {}

/** The person deleted the account at `at`: its name and email are erased, its id stays and means no one any more (request 35). It carries no name and no email. */
export class AccountDeletedEvent extends DomainEvent<{ accountId: string; at: string }> {}
