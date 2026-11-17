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

/**
 * The expense changed since the version the edit was made from was read: its author reads it again and decides (feature 6).
 * Refused by name, after a second writer's edit was kept and this one was re-decided against it.
 */
export class ExpenseChangedSinceReadException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ExpenseChangedSinceRead',
      message: 'The expense changed since it was read: read it again, and decide',
    });
  }
}

/** Each amount of a split by exact amounts is a whole number, 0 or more (request 7). */
export class InvalidSplitAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidSplitAmount',
      message: 'Each exact amount must be a whole number, 0 or more',
    });
  }
}

/** The exact amounts of a split add up to the expense's amount, exactly (request 7). */
export class SplitAmountsDoNotAddUpException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'SplitAmountsDoNotAddUp',
      message: 'The exact amounts must add up to the amount of the expense',
    });
  }
}

/** Each member of a split by shares has a whole number of shares, at least 1 (request 7). */
export class InvalidSplitSharesException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidSplitShares',
      message: 'Each member must have a whole number of shares, at least 1',
    });
  }
}

/**
 * The expense concerns a member who is no longer in its group, as its payer or in its split: it can no longer be changed or
 * deleted, so that that member's balance stays 0 and the group's balances still add up to 0 (request 9).
 */
export class ExpenseHasFormerMemberException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'ExpenseHasFormerMember',
      message: 'The expense concerns a member who left the group, so it can no longer be changed or deleted',
    });
  }
}
