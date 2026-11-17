import { Exception } from '@Architecture/Domain';

/** The description is 1 to 100 characters, and not only spaces (after trimming). */
export class InvalidExpenseDescriptionException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidExpenseDescription',
      message: 'The description must have 1 to 100 characters, and not only spaces',
    });
  }
}

/** The amount is a whole number from 1 to 100 000 000, in the group's currency. */
export class InvalidExpenseAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidExpenseAmount',
      message: 'The amount must be a whole number from 1 to 100000000',
    });
  }
}

/** The date is a real day of the calendar, written YYYY-MM-DD, and not after today in UTC. */
export class InvalidExpenseDateException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidExpenseDate',
      message: 'The date must be a real day, written YYYY-MM-DD, and not after today (UTC)',
    });
  }
}

/** Each member of the split is a member of the group. */
export class SplitMemberNotInGroupException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitMemberNotInGroup',
      message: 'Each member of the split must be a member of the group',
    });
  }
}

/** Each member is in the split once. */
export class SplitMemberListedTwiceException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitMemberListedTwice',
      message: 'Each member may be listed in the split once',
    });
  }
}

/** The payer is one of the members of the split. */
export class PayerNotInSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'PayerNotInSplit',
      message: 'The payer must be one of the members of the split',
    });
  }
}
