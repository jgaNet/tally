import { Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Ledger';

/** An amount that is not a whole number from 1 to 100 000 000: `422` (request 24). */
export class InvalidBudgetAmountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidBudgetAmount',
      message: 'A budget is a whole number from 1 to 100000000',
    });
  }
}

/** A member who is not the owner of the group sets or removes a budget: `403` (request 24). */
export class NotTheOwnerException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the owner of the group may set or remove its budgets');
  }
}

/** A budget is removed for a category the group has none for: `404` (request 24). */
export class BudgetNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No budget is set for this category in this group');
  }
}
