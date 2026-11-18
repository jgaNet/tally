import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Expense aggregate and its value objects make. */
export abstract class LedgerException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Ledger', type, message, context });
  }
}

export class InvalidDescription extends LedgerException {
  constructor() {
    super('InvalidDescription', 'A description has 1 to 100 characters and is not only spaces');
  }
}

export class InvalidAmount extends LedgerException {
  constructor() {
    super('InvalidAmount', 'An amount is a whole number from 1 to 100 000 000');
  }
}

export class InvalidDate extends LedgerException {
  constructor() {
    super('InvalidDate', 'A date is a real day of the calendar, written YYYY-MM-DD');
  }
}

export class DateInTheFuture extends LedgerException {
  constructor() {
    super('DateInTheFuture', 'An expense cannot be spent after today, in UTC');
  }
}

/** An exact amount is a whole number, 0 or more: a split by exact amounts gives each member such an amount. */
export class InvalidShareAmount extends LedgerException {
  constructor() {
    super('InvalidShareAmount', 'Each exact amount is a whole number, 0 or more');
  }
}

/** The exact amounts of a split add up to the amount of the expense, exactly. */
export class ShareAmountsDoNotAddUp extends LedgerException {
  constructor() {
    super('ShareAmountsDoNotAddUp', "The exact amounts add up to the expense's amount");
  }
}

/** A member's shares are a whole number, at least 1. */
export class InvalidShareCount extends LedgerException {
  constructor() {
    super('InvalidShareCount', 'Each member has a whole number of shares, at least 1');
  }
}

/** A member is listed twice in the split: each member is in it once. */
export class DuplicateSplitMember extends LedgerException {
  constructor() {
    super('DuplicateSplitMember', 'Each member is listed once in the split');
  }
}

/** The payer is always one of the members the expense is split between. */
export class PayerNotInSplit extends LedgerException {
  constructor() {
    super('PayerNotInSplit', 'The payer is one of the members the expense is split between');
  }
}

/** Only a member of the group may be in its split. */
export class NotAMemberOfTheGroup extends LedgerException {
  constructor() {
    super('NotAMemberOfTheGroup', 'Only members of the group may be in the split');
  }
}

/**
 * An expense whose payer, or one of whose split members, has left the group cannot change or be deleted: their balance stays
 * 0 and the group's balances still add up to 0 (request 9).
 */
export class ExpenseConcernsAFormerMember extends LedgerException {
  constructor() {
    super('ExpenseConcernsAFormerMember', 'An expense that concerns a member who has left the group cannot change');
  }
}

/** An edit made from a version the expense has since left: its author reads it again and decides. */
export class ExpenseChanged extends LedgerException {
  constructor() {
    super('ExpenseChanged', 'The expense has changed since you read it: read it again and decide');
  }
}

/** Only the payer of an expense, or the owner of its group, may edit or delete it. */
export class NotThePayerOrTheOwner extends LedgerException {
  constructor() {
    super('NotThePayerOrTheOwner', 'Only the payer of an expense or the owner of the group may change it');
  }
}

/** A currency is one of Tally's (request 2): an expense paid in another currency names one of them. */
export class InvalidOriginalCurrency extends LedgerException {
  constructor() {
    super('InvalidOriginalCurrency', 'A currency is one of EUR, USD, GBP, CHF, CAD or AUD');
  }
}

/** An expense paid in another currency is in a currency other than its group's: the group's own needs no rate. */
export class SameCurrencyAsTheGroup extends LedgerException {
  constructor() {
    super('SameCurrencyAsTheGroup', "An expense in another currency is in a currency other than the group's");
  }
}

/** The amount paid in another currency is a whole number of its hundredths, from 1 to 100 000 000, like any amount. */
export class InvalidOriginalAmount extends LedgerException {
  constructor() {
    super('InvalidOriginalAmount', 'An amount in another currency is a whole number from 1 to 100 000 000');
  }
}

/** A rate is a decimal number above 0, written as text, with at most 6 digits after the point. */
export class InvalidRate extends LedgerException {
  constructor() {
    super('InvalidRate', 'A rate is a number above 0, written as text, with at most 6 digits after the point');
  }
}
