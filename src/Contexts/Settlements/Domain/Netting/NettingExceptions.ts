import { SettlementsException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** There is nothing to net: in no group they share, in the currency, does one of them owe what the other is owed. Nothing changes. */
export class NothingToNet extends SettlementsException {
  constructor() {
    super('NothingToNet', 'There is nothing to net between the two of them in this currency');
  }
}

/** A netting is with another member, not with oneself. */
export class NettingWithSelf extends SettlementsException {
  constructor() {
    super('NettingWithSelf', 'A netting is with another member, not with oneself');
  }
}

/** A netting is in one of the currencies Tally keeps accounts in. */
export class CurrencyNotSupported extends SettlementsException {
  constructor() {
    super('CurrencyNotSupported', 'The currency is not one Tally keeps accounts in');
  }
}
