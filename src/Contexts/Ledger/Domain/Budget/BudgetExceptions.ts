import { Exception } from '@Architecture/Domain';

/** The amount of a budget is not a whole number from 1 to 100 000 000 (request 24). */
export class InvalidBudgetAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidBudgetAmount',
      message: 'A budget is an amount of 1 to 100000000, in whole units of the group currency',
    });
  }
}
