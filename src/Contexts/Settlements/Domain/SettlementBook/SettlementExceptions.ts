import { Exception } from '@Architecture/Domain';

/** The amount is a whole number of at least 1, in the group's currency. */
export class InvalidSettlementAmountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'InvalidSettlementAmount',
      message: 'The amount must be a whole number of at least 1',
    });
  }
}

/** The payer is a member of the group. */
export class SettlementPayerNotMemberException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementPayerNotMember',
      message: 'The payer must be a member of the group',
    });
  }
}

/** A settlement is between two members: the payer is not the payee. */
export class SettlementToSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementToSelf',
      message: 'The payer and the payee must be two different members',
    });
  }
}

/** The amount is no more than what the payer owes, the opposite of their balance. */
export class SettlementMoreThanOwedException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementMoreThanOwed',
      message: 'The payer does not owe that much',
    });
  }
}

/** The amount is no more than what the payee is owed, their balance. */
export class SettlementMoreThanIsOwedException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementMoreThanIsOwed',
      message: 'The payee is not owed that much',
    });
  }
}
