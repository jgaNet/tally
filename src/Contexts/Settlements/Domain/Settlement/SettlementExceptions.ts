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

/** The amount is more than the payer still owes or more than the payee is still owed when it is decided (requests 12, 13), `422`. */
export class SettlementExceedsDebtException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementExceedsDebt',
      message: 'A settlement is at most what the payer owes and at most what the payee is owed',
    });
  }
}

/**
 * The provider gave no payment link for the settlement: it answered other than `201` with an id and a link, did not answer within
 * 5 seconds, or is not configured (`PROVIDER_URL`). Nothing is kept (request 13); `422`, as a refusal of the operation, never `5xx`.
 */
export class ProviderUnavailableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'ProviderUnavailable',
      message: 'The payment provider gave no payment link for this settlement',
    });
  }
}

/**
 * The settlement cannot be refunded: it is not a settlement through the provider that is paid (a cash one, a refunded or a refunding one,
 * a failed or pending one), or one of its payer and payee has left the group (request 15, docs/adr/0015). Nothing changes; `422`.
 */
export class SettlementNotRefundableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotRefundable',
      message:
        'A settlement is refunded only while it is paid through the provider, and both its members are still in the group',
    });
  }
}
