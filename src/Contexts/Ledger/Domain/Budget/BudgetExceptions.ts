import { Exception } from '@Architecture/Domain';

/** The budget is not from 1 to 100 000 000 in the group's currency. */
export class InvalidBudgetAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidBudgetAmount',
      message: 'A budget is from 1 to 100 000 000 in the group’s currency',
    });
  }
}

/** The category has no budget to remove: none was set, or it was removed already. */
export class NoBudgetException extends Exception {
  constructor() {
    super({ service: 'Ledger', type: 'NoBudget', message: 'The category has no budget to remove' });
  }
}
