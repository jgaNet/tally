import { ConflictException, Exception } from '@Architecture/Domain';

/** The description is not 1 to 100 characters, or is only spaces. */
export class InvalidExpenseDescriptionException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidExpenseDescription',
      message: 'The description has 1 to 100 characters, and is not only spaces',
    });
  }
}

/** The amount is not a whole number from 1 to 100 000 000. */
export class InvalidAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidAmount',
      message: 'The amount is a whole number from 1 to 100000000',
    });
  }
}

/** The date is not a real day of the calendar, or is after today in UTC. */
export class InvalidExpenseDateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidExpenseDate',
      message: 'The date is a real day, YYYY-MM-DD, not after today (UTC)',
    });
  }
}

/** The split lists someone who is not a current member of the group. */
export class SplitWithStrangerException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitWithStranger',
      message: 'Only members of the group may be in a split',
    });
  }
}

/** The split lists the same member twice. */
export class SplitListsTwiceException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitListsTwice',
      message: 'Each member may be listed once in a split',
    });
  }
}

/** The split does not include the member who paid. */
export class SplitWithoutPayerException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitWithoutPayer',
      message: 'The payer is one of the members of the split',
    });
  }
}

/** The expense changed since the version the edit was made from: its author reads it again and decides. */
export class ExpenseChangedException extends ConflictException {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ExpenseChanged',
      message: 'The expense changed since it was read',
    });
  }
}

/** An exact amount of a split is not a whole number of 0 or more. */
export class InvalidSplitAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidSplitAmount',
      message: 'Each exact amount of a split is a whole number, 0 or more',
    });
  }
}

/** The exact amounts of a split do not add up to the amount of the expense. */
export class SplitAmountsDoNotAddUpException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitAmountsDoNotAddUp',
      message: 'The exact amounts of a split add up to the amount of the expense',
    });
  }
}

/** A member of a split by shares has less than 1 share, or not a whole number of them. */
export class InvalidSharesException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidShares',
      message: 'Each member of a split by shares has a whole number of shares, at least 1',
    });
  }
}

/** The expense concerns a member who left the group (as its payer or in its split): it can no longer change (request 9). */
export class ExpenseOfFormerMemberException extends ConflictException {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ExpenseOfFormerMember',
      message: 'The expense concerns a member who left the group, so it can no longer change',
    });
  }
}

/** The original currency is not one of Tally's, or is the group's own currency (request 21). */
export class InvalidOriginalCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidOriginalCurrency',
      message: 'The original currency is one of EUR, USD, GBP, CHF, CAD or AUD, other than the group’s',
    });
  }
}

/** The original amount is not a whole number of hundredths from 1 to 100 000 000. */
export class InvalidOriginalAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidOriginalAmount',
      message: 'The original amount is a whole number from 1 to 100000000, in the hundredths of its currency',
    });
  }
}

/** No rate is offered for the currency and the day of the expense, so its rate cannot be left out, nor checked (request 22). */
export class NoRateOfferedException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'NoRateOffered',
      message: 'No rate is offered for the currency and the day of the expense',
    });
  }
}

/** The rate differs by more than 2 % from the rate offered for the expense’s currency and day (request 22). */
export class RateOutsideBandException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'RateOutsideBand',
      message: 'The rate differs by more than 2 % from the rate offered for its currency and day',
    });
  }
}

/** The rate is not a decimal string greater than 0, with at most 6 digits after the point. */
export class InvalidRateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidRate',
      message: 'The rate is a number greater than 0, with at most 6 digits after the point',
    });
  }
}
