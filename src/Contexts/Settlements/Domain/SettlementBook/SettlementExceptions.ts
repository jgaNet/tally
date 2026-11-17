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

/** The payee is a member of the group (request 13: a payment to an account outside it is refused). */
export class SettlementPayeeNotMemberException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementPayeeNotMember',
      message: 'The payee must be a member of the group',
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

/**
 * The provider did not give a payment link within its limit, or answered anything else (request 13): the request is refused and
 * nothing is kept. Answered as a refusal, never a 5xx (the API's `4xx` only).
 */
export class ProviderUnavailableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'ProviderUnavailable',
      message: 'The payment provider did not give a payment link',
    });
  }
}

/** A refund is asked of a settlement paid in cash: only a settlement paid through the provider is refunded through Tally (request 15). */
export class SettlementNotThroughProviderException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotThroughProvider',
      message: 'Only a settlement paid through the provider is refunded through Tally',
    });
  }
}

/** A refund is asked of a settlement that is not paid: pending, failed, already being refunded, or refunded (request 15). */
export class SettlementNotPaidException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotPaid',
      message: 'Only a paid settlement is refunded',
    });
  }
}

/** The payer or the payee of the settlement has left the group, so the settlement is not refunded (request 9, request 15). */
export class RefundPartyNotMemberException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'RefundPartyNotMember',
      message: 'The payer and the payee must both still be members of the group',
    });
  }
}

/** The provider did not refund the payment within its limit, or answered anything else: the refund is refused and nothing changes. */
export class ProviderRefundUnavailableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'ProviderRefundUnavailable',
      message: 'The payment provider did not refund the payment',
    });
  }
}
