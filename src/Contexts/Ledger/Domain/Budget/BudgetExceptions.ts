import { LedgerException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** Only the owner of a group sets or removes its budgets (request 24). */
export class NotTheOwnerOfTheGroup extends LedgerException {
  constructor() {
    super('NotTheOwnerOfTheGroup', 'Only the owner of the group sets or removes its budgets');
  }
}

/** A budget that is not set cannot be removed. */
export class BudgetNotSet extends LedgerException {
  constructor() {
    super('BudgetNotSet', 'The group has no budget for this category');
  }
}
