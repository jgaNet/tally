import { ConflictException } from '@Architecture/Domain';

/**
 * The one rule every context refuses a change by, while an account is suspended (request 34): recording an expense, a recurring
 * expense, a cash settlement, a payment through the provider or a netting, by the account that is suspended. Its name is the same
 * in every context, so a client reads the same `type` whatever the change. Decided once, by Groups, as the Account decides it.
 */
export class AccountSuspendedException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountSuspended',
      message: 'The account is suspended: it cannot make this change',
    });
  }
}
