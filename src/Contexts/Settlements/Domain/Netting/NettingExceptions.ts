import { Exception } from '@Architecture/Domain';

/** A netting is between two different people: the one who asks and the one they net with. */
export class NettingWithSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NettingWithSelf',
      message: 'A netting is between two different people',
    });
  }
}

/** The currency is not one of Tally's, so nothing is netted in it (request 32). */
export class UnknownCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'UnknownCurrency',
      message: 'The currency is not one of the currencies Tally counts in',
    });
  }
}

/** The two people owe each other nothing to net, across the groups they share in this currency, that is not archived. */
export class NothingToNetException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NothingToNet',
      message: 'There is nothing to net between the two of them in this currency',
    });
  }
}
