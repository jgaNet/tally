import { ConflictException, Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Ledger';

/** A description that is empty, only spaces, or longer than 100 characters: `422` (ADR 4). */
export class InvalidExpenseDescriptionException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidExpenseDescription',
      message: 'An expense description has 1 to 100 characters, and is not only spaces',
    });
  }
}

/** An amount that is not a whole number from 1 to 100 000 000 of the group's currency's hundredths: `422`. */
export class InvalidExpenseAmountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidExpenseAmount',
      message: 'An expense amount is a whole number from 1 to 100000000',
    });
  }
}

/** A date that is not a real day of the calendar, or is after today in UTC: `422`. */
export class InvalidExpenseDateException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidExpenseDate',
      message: 'An expense is on a real day of the calendar, not after today (UTC)',
    });
  }
}

/** A member the split names is not a member of the group: `422`. */
export class SplitMemberNotInGroupException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'SplitMemberNotInGroup',
      message: 'Only members of the group can be in a split',
    });
  }
}

/** A member is listed twice in the split: `422`. */
export class DuplicateSplitMemberException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'DuplicateSplitMember', message: 'A member is listed once in a split' });
  }
}

/** The payer is not one of the members the expense is split between: `422`. */
export class PayerNotInSplitException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'PayerNotInSplit',
      message: 'The payer is one of the members the expense is split between',
    });
  }
}

/** An exact amount of a split that is not a whole number of 0 or more: `422` (request 7). */
export class InvalidSplitAmountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidSplitAmount',
      message: 'Each exact amount of a split is a whole number, 0 or more',
    });
  }
}

/** The exact amounts of a split that do not add up to the expense's amount, exactly: `422` (request 7). */
export class SplitAmountsDoNotAddUpException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'SplitAmountsDoNotAddUp',
      message: 'The exact amounts of a split add up to the amount of the expense',
    });
  }
}

/** A member of a split with shares that are not a whole number of 1 or more: `422` (request 7). */
export class InvalidSplitSharesException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidSplitShares',
      message: 'Each member of a split has a whole number of shares, at least 1',
    });
  }
}

/**
 * The expense concerns a member who has left the group, as its payer or in its split: `422`. It can no longer be edited or
 * deleted, so that the member's balance stays 0 and the group's balances still add up to 0 (feature 9, ADR 4).
 */
export class ExpenseConcernsFormerMemberException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'ExpenseConcernsFormerMember',
      message: 'An expense that concerns a member who has left the group can no longer be changed',
    });
  }
}

/**
 * The expense changed since the version the edit was made from: `409`. The author reads it again and decides (ADR 8): two
 * edits from one version, one of them is kept and the other is refused by this name.
 */
export class ExpenseChangedException extends ConflictException {
  constructor() {
    super(SERVICE, 'ExpenseChanged', 'The expense changed since it was read: read it again and decide');
  }
}

/** The caller is neither the expense's payer nor the group's owner: `403` to a signed-in member, who is in the group. */
export class NotThePayerOrOwnerException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the payer of an expense or the owner of its group may change it');
  }
}

/** The group is not there for the caller: the same `404` for a group that does not exist and one the caller is not in. */
export class GroupNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No group is there for you with this id');
  }
}

/** The expense is not there for the caller: the same `404` for an expense that does not exist and one of a group they are not in. */
export class ExpenseNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No expense is there for you with this id');
  }
}

/**
 * The member whose statement is read has never been a member of the group: the same `404` as a statement that does not exist,
 * for a caller who is in the group (request 8).
 */
export class StatementNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No statement is there for you with this member id');
  }
}

/** The currency of an expense in another currency is not one of Tally's currencies: `422` (request 21). */
export class InvalidOriginalCurrencyException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidOriginalCurrency',
      message: 'The currency of an expense is one of the currencies Tally knows',
    });
  }
}

/** The currency of an expense in another currency is the group's own: `422` (request 21). */
export class OriginalCurrencyIsGroupCurrencyException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'OriginalCurrencyIsGroupCurrency',
      message: 'An expense in another currency is in a currency other than the group’s',
    });
  }
}

/** The original amount of an expense in another currency is not a whole number from 1 to 100 000 000: `422` (request 21). */
export class InvalidOriginalAmountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidOriginalAmount',
      message: 'The original amount is a whole number from 1 to 100000000, in the hundredths of its currency',
    });
  }
}

/** The rate is not a positive decimal with at most six digits after the point: `422` (request 21). */
export class InvalidOriginalRateException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidOriginalRate',
      message: 'The rate is a decimal number greater than 0, with at most 6 digits after the point',
    });
  }
}
