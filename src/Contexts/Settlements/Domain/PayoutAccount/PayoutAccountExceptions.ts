import { Exception } from '@Architecture/Domain';

/** The provider does not know the account: it answered that it has no such account, so it is refused (request 16). */
export class UnknownPayoutAccountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'UnknownPayoutAccount',
      message: 'The payment provider does not know this payout account',
    });
  }
}
