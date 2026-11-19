import { Exception } from '@Architecture/Domain';

/** A netting is between two members: the one who asks and the other are not the same one (request 32). */
export class NettingWithSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NettingWithSelf',
      message: 'A netting is between two different members',
    });
  }
}

/** The currency is one of Tally's currencies (request 2, request 32). */
export class NettingCurrencyUnknownException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NettingCurrencyUnknown',
      message: 'The currency is not one of the currencies Tally knows',
    });
  }
}

/**
 * The two members have nothing to net in the currency: across the groups they share, what either can pay the other is 0 (request 32).
 * Nothing is recorded, and the netting is refused by this name.
 */
export class NothingToNetException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'NothingToNet',
      message: 'The two members have nothing to net in that currency',
    });
  }
}
