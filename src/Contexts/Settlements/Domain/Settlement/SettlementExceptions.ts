import { Exception } from '@Architecture/Domain';

/** The amount is not a whole number of at least 1 (request 12): a value the domain does not allow, `422`. */
export class InvalidSettlementAmountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'InvalidSettlementAmount',
      message: 'A settlement is a whole amount of at least 1, in the group currency',
    });
  }
}

/** The payer is the payee: a member does not pay itself (request 12), `422`. */
export class SettlementToSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementToSelf',
      message: 'A settlement is paid by one member to another',
    });
  }
}

/** The amount is more than the payer owes or more than the payee is owed when it is recorded (request 12), `422`. */
export class SettlementExceedsDebtException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementExceedsDebt',
      message: 'A settlement is at most what the payer owes and at most what the payee is owed',
    });
  }
}
