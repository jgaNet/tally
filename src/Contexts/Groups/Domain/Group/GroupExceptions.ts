import { Exception } from '@Architecture/Domain';

/** The name is empty, only spaces, or longer than 60 characters. */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'A group has a name of 1 to 60 characters, that is not only spaces',
    });
  }
}

/** The currency is not one of the six a group may be in. */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD or AUD',
    });
  }
}

/** The owner created the group and stays in it: its owner cannot leave it (request 9). */
export class OwnerCannotLeaveException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnerCannotLeave',
      message: 'The owner of a group cannot leave it',
    });
  }
}

/** A member leaves a group once its balance in it is 0: not while it owes or is owed (request 9). */
export class BalanceNotZeroException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'BalanceNotZero',
      message: 'A member leaves a group once its balance in it is 0',
    });
  }
}
