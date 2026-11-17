import { SettlementsException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/**
 * A payout account is one the provider knows: a refusal, when it does not know it, when it answers anything else, or when it does not
 * answer within its limit. Nothing is set.
 */
export class UnknownPayoutAccount extends SettlementsException {
  constructor() {
    super('UnknownPayoutAccount', 'The payment provider does not know the payout account');
  }
}
