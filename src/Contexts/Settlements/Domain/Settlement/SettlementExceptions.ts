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

/** Only the payee of a settlement may refund it (request 15). */
export class NotThePayee extends SettlementException {
  constructor() {
    super('NotThePayee', 'Only the payee of a settlement may refund it');
  }
}

/** A settlement in cash is not refunded through Tally (request 15). */
export class CashSettlementNotRefundable extends SettlementException {
  constructor() {
    super('CashSettlementNotRefundable', 'A settlement in cash is not refunded through Tally');
  }
}

/** Only a settlement that is paid, and not yet refunding or refunded, is refunded (request 15). */
export class SettlementNotPaid extends SettlementException {
  constructor() {
    super('SettlementNotPaid', 'Only a settlement that is paid can be refunded');
  }
}

/** The provider did not accept the refund: it is not configured, did not answer in time, or answered anything else (ADR 9). */
export class RefundUnavailable extends SettlementException {
  constructor() {
    super('RefundUnavailable', 'The payment provider did not accept the refund, and nothing changed');
  }
}

/** The provider did not give a payment link: it is not configured, did not answer, or answered anything else (ADR 8). */
export class ProviderUnavailable extends SettlementException {
  constructor() {
    super('ProviderUnavailable', 'The payment provider did not give a payment link, and nothing was recorded');
  }
}
