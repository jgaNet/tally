import { Exception, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Settlements';

/** A netting with oneself: a member has nothing to net with themselves: `422` (request 32). */
export class NettingWithOneselfException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'NettingWithOneself',
      message: 'A netting is between two members, not with oneself',
    });
  }
}

/**
 * The two members have nothing to net in the currency: no group they share in it, not archived, where each owes the other, or no
 * netting of an amount of at least 1 (a currency that is not Tally's has no such group either): `422`, nothing changes (request 32).
 */
export class NothingToNetException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'NothingToNet',
      message: 'The two members have nothing to net in this currency across their groups',
    });
  }
}

/** The netting is not there for the caller: the same `404` for one that does not exist and one between two other members (request 32). */
export class NettingNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No netting is there for you with this id');
  }
}
