import { ConflictException } from '@Architecture/Domain';

/**
 * The one rule every context refuses a change by, while the account is deleted (request 35): a new expense or recurring expense
 * that lists it, a payment through the provider it pays or receives, and a netting with it. Its name is the same in every context,
 * so a client reads the same `type` whatever the change. Decided once, by Groups, as the Account decides it; no context keeps a copy.
 */
export class AccountDeletedException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountDeleted',
      message: 'The account is deleted: it cannot make this change',
    });
  }
}
