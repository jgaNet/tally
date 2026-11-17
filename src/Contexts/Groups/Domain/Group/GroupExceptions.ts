import { Exception } from '@Architecture/Domain';

/** The name is 1 to 60 characters, and not only spaces (after trimming). */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'The name must have 1 to 60 characters, and not only spaces',
    });
  }
}

/** The currency is one of the six the group may be in: EUR, USD, GBP, CHF, CAD, AUD. */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'The currency must be one of EUR, USD, GBP, CHF, CAD, AUD',
    });
  }
}

/** The account is a member of the group already: it joins once. */
export class AlreadyMemberException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AlreadyMember',
      message: 'You are a member of this group already',
    });
  }
}

/** The owner created the group and stays in it: the owner cannot leave it (request 9). */
export class OwnerCannotLeaveException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnerCannotLeave',
      message: 'The owner of a group cannot leave it',
    });
  }
}

/** A member leaves only once their balance in the group is 0 (request 9). */
export class BalanceNotZeroException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'BalanceNotZero',
      message: 'You can leave the group only once your balance in it is 0',
    });
  }
}
