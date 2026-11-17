import { Exception, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Settlements';

/**
 * The payment provider does not know the account, or did not confirm it: it answered anything but `200 { id }` for it, did not answer
 * within 5 seconds, or none is configured. Nothing is set: `422` (request 16).
 */
export class UnknownPayoutAccountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'UnknownPayoutAccount',
      message: 'The payment provider does not know this account, or did not confirm it: nothing was set',
    });
  }
}

/** The caller has no payout account yet: `404` to a read of it (request 16). */
export class PayoutAccountNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'You have no payout account yet');
  }
}

/** The payee of a payment through the provider has no payout account: refused by name, before the provider is asked (request 16). */
export class PayeeHasNoPayoutAccountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'PayeeHasNoPayoutAccount',
      message: 'The payee has no payout account at the payment provider, so they cannot be paid through it',
    });
  }
}
