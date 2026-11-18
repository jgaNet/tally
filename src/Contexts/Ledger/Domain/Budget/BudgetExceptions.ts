import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Budget aggregate makes. */
export abstract class BudgetException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Ledger', type, message, context });
  }
}

export class InvalidBudgetAmount extends BudgetException {
  constructor() {
    super('InvalidBudgetAmount', 'The budget must be a whole number from 1 to 100000000');
  }
}

export class NotAllowedToChangeBudget extends BudgetException {
  constructor() {
    super('NotAllowedToChangeBudget', 'Only the owner of the group may set or remove a budget of it');
  }
}
