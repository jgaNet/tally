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

/** What was paid in another currency is not an amount of 1 to 100 000 000 in that currency's hundredths (request 21). */
export class InvalidOriginalAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidOriginalAmount',
      message: 'What was paid in another currency is an amount of 1 to 100000000, in hundredths of that currency',
    });
  }
}

/** What was paid in another currency is not one of Tally's currencies (request 2, request 21). */
export class UnknownCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'UnknownCurrency',
      message: "What was paid in another currency is in one of Tally's currencies",
    });
  }
}

/** What was paid in another currency is in the group's own currency: then it is simply the amount (request 21). */
export class OriginalCurrencyIsGroupCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'OriginalCurrencyIsGroupCurrency',
      message: "What was paid in another currency is in a currency other than the group's",
    });
  }
}

/** A rate is not a decimal number written as a string, with at most 6 digits after the point (request 21). */
export class InvalidRateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidRate',
      message: 'A rate is a decimal number of at most 6 digits after the point, written as a string',
    });
  }
}

/** A rate is 0: what one unit of another currency is worth must be greater than 0 (request 21). */
export class NonPositiveRateException extends Exception {
  constructor() {
    super({ service: 'Ledger', type: 'NonPositiveRate', message: 'A rate is greater than 0' });
  }
}

/**
 * No rate is offered for the expense's currency to the group's on its date, so the expense cannot be recorded at one: a rate the
 * payer gives is refused as well, as there is nothing to compare it with (request 22, docs/adr/0021).
 */
export class NoRateOfferedException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'NoRateOffered',
      message:
        'No rate is offered for the currency on the date of the expense, so it cannot be recorded in the group currency',
    });
  }
}

/**
 * The rate the payer gives differs from the rate offered for the expense's currency on its date by more than 2 % of the offered one
 * (request 22, docs/adr/0021).
 */
export class RateOutsideBandException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'RateOutsideBand',
      message: 'A rate differs from the rate offered for its currency on the date of the expense by more than 2 %',
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
 * The payer of an expense, or one of the members it is split between, is no longer a member of its group: the expense is kept
 * as it was, so that the balances still add up to 0 (request 9, docs/adr/0009). It can be neither edited nor deleted.
 */
export class ExpenseOfFormerMemberException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ExpenseOfFormerMember',
      message: 'An expense whose payer or one of whose members has left the group can no longer be changed or deleted',
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
