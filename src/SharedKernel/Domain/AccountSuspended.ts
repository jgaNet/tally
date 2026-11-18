import { Exception } from '@Architecture/Domain';

/**
 * The one rule every context refuses an expense, a recurring expense, a cash settlement, a payment through the provider or a netting by a
 * suspended account (feature 34, request 34): the account is suspended, so it starts nothing until it is reinstated. The word is the shared
 * kernel's, named once here and decided by Groups (the storm's T17, as GroupArchived is): each context asks Groups, through the port it owns
 * (`isSuspended`), whether the account that starts the change is suspended, and its aggregate refuses by this exception. A refusal by a rule:
 * `422` (ADR 4). The same name and the same answer for every request a suspended account would start, in any group; nothing else is refused.
 */
export const ACCOUNT_SUSPENDED = 'AccountSuspended';

export class AccountSuspendedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: ACCOUNT_SUSPENDED,
      message: 'The account is suspended: it starts nothing until it is reinstated',
    });
  }
}
