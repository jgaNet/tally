import { ExpenseException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

export class InvalidStartsOn extends ExpenseException {
  constructor() {
    super(
      'InvalidStartsOn',
      'The day it starts on must be a day of the calendar from the 1st to the 28th of its month, no more than 365 days before or after today',
    );
  }
}

export class NotAllowedToStopRecurringExpense extends ExpenseException {
  constructor() {
    super(
      'NotAllowedToStopRecurringExpense',
      'Only the payer of the recurring expense or the owner of its group may stop it',
    );
  }
}
