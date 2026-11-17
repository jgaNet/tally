import { Exception, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Groups';

/** A group name that is empty, only spaces, or longer than 60 characters: `422` (ADR 4, ADR 5). */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidGroupName',
      message: 'A group name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** A currency that is not one of the six a group may be in: `422` (ADR 5). */
export class UnsupportedCurrencyException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'UnsupportedCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD or AUD',
    });
  }
}

/**
 * The group is not there for the caller: it does not exist, or the caller is not one of its members. Both are the same
 * answer, `404`, so nobody learns that a group exists (ADR 5).
 */
export class GroupNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No group is there for you with this id');
  }
}
