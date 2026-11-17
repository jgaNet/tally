import { Exception } from '@Architecture/Domain';

/** The amount is not a whole number of at least 1. */
export class InvalidSettlementAmountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'InvalidSettlementAmount',
      message: 'The amount is a whole number of at least 1',
    });
  }
}

/** A member cannot settle with themselves: the payer and the payee are different members. */
export class SettlementToSelfException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementToSelf',
      message: 'A settlement is between two different members',
    });
  }
}

/** The payer is not a member of the group. */
export class SettlementPayerNotMemberException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementPayerNotMember',
      message: 'The payer is not a member of the group',
    });
  }
}

/** The amount is more than the payer owes, or more than the payee is owed, at the moment it is recorded. */
export class SettlementExceedsBalanceException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementExceedsBalance',
      message: 'The amount is more than the payer owes, or more than the payee is owed',
    });
  }
}
