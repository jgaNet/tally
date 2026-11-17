import { ConcurrencyConflictException, Exception } from '@Architecture/Domain';

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

/** A member's amount of an exact split is not a whole number of 0 or more (request 7). */
export class InvalidSplitAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidSplitAmount',
      message: 'An exact split gives each member a whole amount of 0 or more',
    });
  }
}

/** The exact amounts of a split do not add up to the expense's amount (request 7). */
export class SplitDoesNotAddUpException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitDoesNotAddUp',
      message: 'The exact amounts of an expense add up to its amount',
    });
  }
}

/** A member's shares are not a whole number of 1 or more (request 7). */
export class InvalidSharesException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidShares',
      message: 'A split by shares gives each member a whole number of 1 or more shares',
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

/**
 * The expense changed since the version the edit was made from: its author reads it again and decides (request 6). It is a
 * conflict, so a use case re-reads and re-decides it first, and the last conflict is the refusal (`409`, ADR 0006).
 */
export class ExpenseChangedException extends ConcurrencyConflictException {
  constructor() {
    super('Ledger', 'The expense changed since it was read: read it again and decide');
    this.type = 'ExpenseChanged';
  }
}
