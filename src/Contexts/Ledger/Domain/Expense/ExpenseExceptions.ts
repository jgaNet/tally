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
