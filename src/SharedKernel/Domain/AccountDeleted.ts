import { Exception } from '@Architecture/Domain';

/**
 * The one rule every context refuses a new expense or recurring expense in whose split a deleted account is, a payment through the provider
 * to a deleted account, and a netting with one (feature 35, request 35): the account is deleted, so nothing new is started with it. The word
 * is the shared kernel's, named once here and decided by Groups (as AccountSuspended is, ADR 29): each context asks Groups, through the port
 * it owns (`isDeleted`), whether the account is deleted. A refusal by a rule: `422` (ADR 4). A cash settlement it receives is still recorded,
 * and a deleted account's balances, expenses and statements read as before; nothing else is refused by this name.
 */
export const ACCOUNT_DELETED = 'AccountDeleted';

export class AccountDeletedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: ACCOUNT_DELETED,
      message: 'The account is deleted: nothing new is started with it',
    });
  }
}
