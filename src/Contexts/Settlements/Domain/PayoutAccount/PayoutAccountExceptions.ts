import { Exception } from '@Architecture/Domain';

/**
 * The payment provider does not know the account asked for, or did not answer about it within its limit, or answered anything else
 * (request 16): the account is refused and the one the person had stays. Answered as a refusal, never a 5xx.
 */
export class UnknownPayoutAccountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'UnknownPayoutAccount',
      message: 'The payment provider does not know that payout account',
    });
  }
}
