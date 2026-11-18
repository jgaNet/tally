import { DomainEvent } from '@Architecture/Domain';

/** An account was signed up. Recorded by `Account.create()`, once the account is stored (docs/adr/0002). */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; name: string }> {}

/** An administrator suspended an account, which then changes nothing until it is reinstated (request 34, docs/adr/0034). */
export class AccountSuspendedEvent extends DomainEvent<{ accountId: string }> {}

/** An administrator reinstated a suspended account (request 34, docs/adr/0034). */
export class AccountReinstatedEvent extends DomainEvent<{ accountId: string }> {}
