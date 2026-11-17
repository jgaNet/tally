import { Exception } from '@Architecture/Domain';

/** The description is empty, only spaces, or longer than 100 characters. */
export class InvalidDescriptionException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidDescription',
      message: 'An expense has a description of 1 to 100 characters, that is not only spaces',
    });
  }
}

/** The amount is not a whole number from 1 to 100 000 000. */
export class InvalidAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidAmount',
      message: 'An expense is an amount of 1 to 100000000, in whole units of the group currency',
    });
  }
}

/** The date is not a real day of the calendar, or is after today (UTC). */
export class InvalidDateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidDate',
      message: 'An expense is dated a real day of the calendar, not after today (UTC)',
    });
  }
}

/** Someone in the split is not a current member of the group. */
export class NotAMemberInSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'NotAMemberInSplit',
      message: 'An expense is split only between current members of the group',
    });
  }
}

/** A member is listed more than once in the split. */
export class DuplicateInSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'DuplicateInSplit',
      message: 'A member is listed once in the split of an expense',
    });
  }
}

/** The payer is not one of the members the expense is split between. */
export class PayerNotInSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'PayerNotInSplit',
      message: 'The payer of an expense is one of the members it is split between',
    });
  }
}
