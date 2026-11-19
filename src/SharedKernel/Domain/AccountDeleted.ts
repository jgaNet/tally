import { Exception } from '@Architecture/Domain';

/**
 * The account is deleted (request 35): it may not be put in the split of a new expense or a recurring expense, nor be paid through the provider,
 * nor be netted with. It is the one rule every context refuses those by, under the same name, as `AccountSuspended` is (ADR 33). Groups decides a
 * deletion and erases the account's name and email; each other context asks Groups whether an account is deleted, through the port it owns, and
 * refuses with this exception. The name is a word of the shared kernel, decided once, as `AccountSuspended` is (ADR 32).
 */
export class AccountDeletedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountDeleted',
      message: 'The account is deleted: it cannot do this',
    });
  }
}
