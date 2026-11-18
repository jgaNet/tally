import { Exception } from '@Architecture/Domain';

/** A netting is between two members: a member does not net with itself (request 32), `422`. */
export class NettingWithSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NettingWithSelf',
      message: 'A netting is between two members',
    });
  }
}

/** The currency is not one of Tally's (request 32), `422`. */
export class UnsupportedNettingCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'UnsupportedNettingCurrency',
      message: 'A netting is in one of the currencies of Tally',
    });
  }
}

/**
 * The two members owe each other nothing to net, in that currency, across the groups they share and that are not archived: the
 * netting is refused and nothing changes (request 32), `422`.
 */
export class NothingToNetException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NothingToNet',
      message: 'The two members owe each other nothing to net in that currency',
    });
  }
}
