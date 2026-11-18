import { LedgerException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** A recurring expense starts on a real day of the calendar, written YYYY-MM-DD, on the 1st to the 28th of its month (request 23). */
export class InvalidStartsOn extends LedgerException {
  constructor() {
    super(
      'InvalidStartsOn',
      'A recurring expense starts on a real day of the calendar, from the 1st to the 28th of its month',
    );
  }
}

/** A recurring expense starts no more than 365 days before today, nor 365 days after it (request 23). */
export class StartsOnOutOfRange extends LedgerException {
  constructor() {
    super('StartsOnOutOfRange', 'A recurring expense starts no more than 365 days before or after today');
  }
}

/** Only the payer of a recurring expense, or the owner of its group, may stop it. */
export class NotThePayerOrTheOwnerOfRecurring extends LedgerException {
  constructor() {
    super(
      'NotThePayerOrTheOwnerOfRecurring',
      'Only the payer of a recurring expense or the owner of the group may stop it',
    );
  }
}

/** A day is recorded only once it has come: the sweep asks for a day that is still to come, which is a programming error. */
export class DayNotYetCome extends LedgerException {
  constructor() {
    super('DayNotYetCome', 'The day of a recurring expense has not come yet');
  }
}
