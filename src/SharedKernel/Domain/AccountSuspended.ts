import { Exception } from '@Architecture/Domain';

/**
 * The account is suspended (request 34): it may not record an expense, set up a recurring expense, record a settlement in cash, ask to pay through
 * the provider, or ask for a netting, in any group, until it is reinstated. It is the one rule every context refuses those by, under the same name,
 * so that a client switches on one word whatever the change was. Groups decides a suspension and keeps the flag; each other context asks Groups
 * whether the account is suspended, through the port it owns, and refuses with this exception. The name is a word of the shared kernel, decided once
 * (ADR 32), as `GroupArchived` is (ADR 24).
 */
export class AccountSuspendedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountSuspended',
      message: 'The account is suspended: it cannot do this',
    });
  }
}
