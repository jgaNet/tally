import { DomainEvent } from '@Architecture/Domain';

/** Someone signed up: the account, known by its id, its email and its name. */
export class AccountRegisteredEvent extends DomainEvent<{ accountId: string; email: string; name: string }> {}
