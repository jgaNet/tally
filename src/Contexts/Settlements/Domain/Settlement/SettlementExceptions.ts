import { Exception } from '@Architecture/Domain';

/** The base of every refusal the SettlementBook makes. */
export abstract class SettlementException extends Exception {
  constructor(type: string, message: string) {
    super({ service: 'Settlements', type, message });
  }
}

export class InvalidSettlementAmount extends SettlementException {
  constructor() {
    super('InvalidSettlementAmount', 'The amount must be a whole number of at least 1');
  }
}

export class PayerIsPayee extends SettlementException {
  constructor() {
    super('PayerIsPayee', 'The payer and the payee must be two different members');
  }
}

export class PayerNotAMember extends SettlementException {
  constructor() {
    super('PayerNotAMember', 'The payer must be a member of the group');
  }
}

export class SettlementExceedsDebt extends SettlementException {
  constructor() {
    super('SettlementExceedsDebt', 'The amount is more than the payer owes, or more than the payee is owed');
  }
}

export class PayeeNotAMember extends SettlementException {
  constructor() {
    super('PayeeNotAMember', 'The payee must be a member of the group');
  }
}

/** The provider did not give a payment link: it is not configured, did not answer, or answered anything else (ADR 8). */
export class ProviderUnavailable extends SettlementException {
  constructor() {
    super('ProviderUnavailable', 'The payment provider did not give a payment link, and nothing was recorded');
  }
}
