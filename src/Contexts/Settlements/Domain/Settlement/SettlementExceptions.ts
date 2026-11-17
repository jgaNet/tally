import { Exception } from '@Architecture/Domain';

/** The base of every refusal the SettlementBook and its settlements make. */
export abstract class SettlementsException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Settlements', type, message, context });
  }
}

/** A settlement's amount is a whole number, at least 1. */
export class InvalidSettlementAmount extends SettlementsException {
  constructor() {
    super('InvalidSettlementAmount', 'An amount is a whole number, at least 1');
  }
}

/** The payer of a settlement is a member of the group. */
export class PayerNotAMember extends SettlementsException {
  constructor() {
    super('PayerNotAMember', 'The payer is a member of the group');
  }
}

/** A settlement is paid by one member to another: a member does not pay themselves. */
export class PaidToSelf extends SettlementsException {
  constructor() {
    super('PaidToSelf', 'A settlement is paid by one member to another, not to the same member');
  }
}

/** A settlement never pays more than the payer owes, at the moment it is recorded. */
export class ExceedsWhatIsOwed extends SettlementsException {
  constructor() {
    super('ExceedsWhatIsOwed', 'The payer owes less than the amount');
  }
}

/** A settlement never pays a member more than they are owed, at the moment it is recorded. */
export class ExceedsWhatIsOwedToPayee extends SettlementsException {
  constructor() {
    super('ExceedsWhatIsOwedToPayee', 'The payee is owed less than the amount');
  }
}
