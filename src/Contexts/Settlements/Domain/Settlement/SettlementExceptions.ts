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

/** A settlement a netting made is not refunded through Tally: nothing moved through it (request 32). */
export class NettedSettlementNotRefundable extends SettlementException {
  constructor() {
    super('NettedSettlementNotRefundable', 'A settlement made by netting is not refunded through Tally');
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

/** A payment is asked of the provider only to a payee who has a payout account at it (request 16, ADR 10). */
export class PayeeHasNoPayoutAccount extends SettlementException {
  constructor() {
    super('PayeeHasNoPayoutAccount', 'The payee has no payout account, so the payment is not asked of the provider');
  }
}

/** The provider does not know the payout account, or did not answer for it as asked: nothing is set (request 16, ADR 10). */
export class UnknownPayoutAccount extends SettlementException {
  constructor() {
    super('UnknownPayoutAccount', 'The payment provider does not know this payout account, and nothing was set');
  }
}

/** The provider did not answer for the payout account: it is not configured, did not answer, or answered anything else (ADR 10). */
export class ProviderAccountUnavailable extends SettlementException {
  constructor() {
    super(
      'ProviderAccountUnavailable',
      'The payment provider did not answer for the payout account, and nothing was set',
    );
  }
}

/** Only a settlement paid through the provider, and still `paid`, is contested (request 33). */
export class SettlementNotContestable extends SettlementException {
  constructor() {
    super('SettlementNotContestable', 'Only a settlement paid through the provider can be contested');
  }
}

/** A settlement is contested once only (request 33, ADR 24). */
export class SettlementAlreadyContested extends SettlementException {
  constructor() {
    super('SettlementAlreadyContested', 'A settlement is contested once only');
  }
}

/** Only a contested settlement is decided by an administrator, once (request 33). */
export class SettlementNotContested extends SettlementException {
  constructor() {
    super('SettlementNotContested', 'Only a contested settlement is decided');
  }
}

/** Only the owner of the group decides who bears the provider's fee (request 38). */
export class OnlyTheOwnerSetsFeePolicy extends SettlementException {
  constructor() {
    super('OnlyTheOwnerSetsFeePolicy', 'Only the owner of the group decides who bears the provider fee');
  }
}

/** Who bears the provider's fee is the payer, the payee or both, shared (request 38). */
export class InvalidFeePolicy extends SettlementException {
  constructor() {
    super('InvalidFeePolicy', 'The provider fee is borne by the payer, the payee or shared');
  }
}

/** The provider's fee is a whole number, 0 or more, and less than the amount; otherwise nothing is kept (request 38). */
export class ProviderFeeOutOfRange extends SettlementException {
  constructor() {
    super(
      'ProviderFeeOutOfRange',
      'The provider fee must be 0 or more and less than the amount, and nothing was recorded',
    );
  }
}

export class InvalidOriginalCurrency extends SettlementException {
  constructor(currencies: readonly string[]) {
    super('InvalidOriginalCurrency', `The currency must be one of ${currencies.join(', ')}`);
  }
}

export class SameCurrencyAsGroup extends SettlementException {
  constructor() {
    super('SameCurrencyAsGroup', "A settlement in another currency must be in a currency other than the group's");
  }
}

export class InvalidOriginalAmount extends SettlementException {
  constructor(max: number) {
    super(
      'InvalidOriginalAmount',
      `The amount in another currency must be a whole number of its currency's minor unit from 1 to ${max}`,
    );
  }
}

export class NoRateOffered extends SettlementException {
  constructor() {
    super('NoRateOffered', 'No rate is offered for that currency on this day, so the settlement is not kept');
  }
}
