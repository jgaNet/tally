import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Expense aggregate and its value objects make. */
export abstract class ExpenseException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Ledger', type, message, context });
  }
}

export class InvalidDescription extends ExpenseException {
  constructor(maxLength: number) {
    super('InvalidDescription', `The description must have 1 to ${maxLength} characters, and not only spaces`);
  }
}

export class InvalidAmount extends ExpenseException {
  constructor(max: number) {
    super('InvalidAmount', `The amount must be a whole number from 1 to ${max}`);
  }
}

export class InvalidDate extends ExpenseException {
  constructor() {
    super('InvalidDate', 'The date must be a day of the calendar, written YYYY-MM-DD');
  }
}

export class DateInTheFuture extends ExpenseException {
  constructor() {
    super('DateInTheFuture', 'The expense cannot be dated after today (UTC)');
  }
}

export class PayerNotInSplit extends ExpenseException {
  constructor() {
    super('PayerNotInSplit', 'The payer must be one of the members the expense is split between');
  }
}

export class MemberListedTwice extends ExpenseException {
  constructor() {
    super('MemberListedTwice', 'Each member can be in the split only once');
  }
}

export class FormerMemberInExpense extends ExpenseException {
  constructor() {
    super('FormerMemberInExpense', 'An expense that concerns a member who left the group can no longer be changed');
  }
}

export class NotAGroupMember extends ExpenseException {
  constructor() {
    super('NotAGroupMember', 'Only members of the group can be in the split of an expense of the group');
  }
}

export class NotAllowedToChangeExpense extends ExpenseException {
  constructor() {
    super('NotAllowedToChangeExpense', 'Only the payer of the expense or the owner of its group may change it');
  }
}

export class OneSplitOnly extends ExpenseException {
  constructor() {
    super('OneSplitOnly', 'An expense is split one way: between members, by exact amounts, or by shares');
  }
}

export class InvalidExactAmount extends ExpenseException {
  constructor() {
    super('InvalidExactAmount', 'Each exact amount must be a whole number of 0 or more');
  }
}

export class ExactAmountsDoNotAddUp extends ExpenseException {
  constructor() {
    super('ExactAmountsDoNotAddUp', 'The exact amounts must add up to the amount of the expense');
  }
}

export class InvalidShares extends ExpenseException {
  constructor() {
    super('InvalidShares', 'Each member must have a whole number of shares, at least 1');
  }
}

export class ExpenseChanged extends ExpenseException {
  constructor() {
    super('ExpenseChanged', 'The expense changed since it was read: read it again, and decide again');
  }
}
