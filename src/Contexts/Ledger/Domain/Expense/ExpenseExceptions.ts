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
