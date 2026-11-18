import { Exception } from '@Architecture/Domain';

/** A budget is a whole number from 1 to 100 000 000, in the group's currency (request 24). */
export class InvalidBudgetAmountException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidBudgetAmount',
      message: 'The budget must be a whole number from 1 to 100000000',
    });
  }
}
