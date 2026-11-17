import { DomainEvent } from '@Architecture/Domain';

/** Someone signed up: the account exists, under the id it was born with. */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; name: string }> {}
