import { DomainEvent } from '@Architecture/Domain';

/** An account was signed up. Recorded by `Account.create()`, once the account is stored (docs/adr/0002). */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; name: string }> {}
