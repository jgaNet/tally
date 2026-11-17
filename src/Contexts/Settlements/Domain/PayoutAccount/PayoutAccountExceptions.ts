import { Exception } from '@Architecture/Domain';

/**
 * The provider does not know the payout account asked for: it answered `404`, or anything else, or did not answer within 5 seconds
 * (request 16). Nothing changes; `422`, as a refusal of the operation.
 */
export class UnknownPayoutAccountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'UnknownPayoutAccount',
      message: 'The payment provider does not know this payout account',
    });
  }
}
