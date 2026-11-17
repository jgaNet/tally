import { Exception } from '@Architecture/Domain';

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
