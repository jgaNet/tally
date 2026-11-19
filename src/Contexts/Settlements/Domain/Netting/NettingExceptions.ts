import { SettlementException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** The currencies Tally keeps money in (request 2): a netting is made in one of them and in no other (request 32). */
export const NETTING_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;

/** A netting is between two different members: a member does not net with themselves (request 32). */
export class NettingWithOneself extends SettlementException {
  constructor() {
    super('NettingWithOneself', 'A netting is between two different members');
  }
}

/** A netting is in one of Tally's currencies (request 32). */
export class UnknownNettingCurrency extends SettlementException {
  constructor() {
    super('UnknownNettingCurrency', "The currency is not one of Tally's currencies");
  }
}

/** Nothing is owed both ways across the groups the two share in that currency, so nothing is netted and nothing changes (request 32). */
export class NothingToNet extends SettlementException {
  constructor() {
    super('NothingToNet', 'There is nothing to net between the two members in this currency');
  }
}
