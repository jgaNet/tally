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

/** A settlement is paid to a member of the group. */
export class PayeeNotAMember extends SettlementsException {
  constructor() {
    super('PayeeNotAMember', 'The payee is a member of the group');
  }
}

/** A payment through the provider needs the provider to answer with a payment link; when it does not, nothing is kept. */
export class ProviderUnavailable extends SettlementsException {
  constructor() {
    super('ProviderUnavailable', 'The payment provider did not give a payment link');
  }
}

/** A refund is asked by the payee of the settlement, and no one else. */
export class OnlyThePayeeMayRefund extends SettlementsException {
  constructor() {
    super('OnlyThePayeeMayRefund', 'Only the payee of a settlement may refund it');
  }
}

/** A settlement in cash is not refunded through Tally: the money went from hand to hand. */
export class CashIsNotRefunded extends SettlementsException {
  constructor() {
    super('CashIsNotRefunded', 'A settlement in cash is not refunded through Tally');
  }
}

/** Only a settlement that is paid is refunded: a pending, failed, refunding or refunded one is not. */
export class OnlyAPaidSettlementIsRefunded extends SettlementsException {
  constructor() {
    super('OnlyAPaidSettlementIsRefunded', 'Only a settlement that is paid can be refunded');
  }
}

/** A payment through the provider is paid to a member who has a payout account: one the provider knows, set by the member. */
export class PayeeHasNoPayoutAccount extends SettlementsException {
  constructor() {
    super('PayeeHasNoPayoutAccount', 'The payee has no payout account at the payment provider');
  }
}

/** A contest is asked by the payee of the settlement, and no one else. */
export class OnlyThePayeeMayContest extends SettlementsException {
  constructor() {
    super('OnlyThePayeeMayContest', 'Only the payee of a settlement may contest it');
  }
}

/** Only a settlement paid through the provider is contested: one paid in cash or by netting is not. */
export class OnlyAProviderSettlementIsContested extends SettlementsException {
  constructor() {
    super('OnlyAProviderSettlementIsContested', 'Only a settlement paid through the provider can be contested');
  }
}

/** A settlement is contested once: a contest decided as paid does not open another. */
export class SettlementAlreadyContested extends SettlementsException {
  constructor() {
    super('SettlementAlreadyContested', 'A settlement is contested once');
  }
}

/** Only a settlement that is paid is contested: a pending, contested, annulled or refunded one is not. */
export class OnlyAPaidSettlementIsContested extends SettlementsException {
  constructor() {
    super('OnlyAPaidSettlementIsContested', 'Only a settlement that is paid can be contested');
  }
}

/** Only a contested settlement is decided, and once: a settlement that is not contested is not decided by an administrator. */
export class OnlyAContestedSettlementIsDecided extends SettlementsException {
  constructor() {
    super('OnlyAContestedSettlementIsDecided', 'Only a contested settlement is decided');
  }
}

/** A refund needs the provider to accept it; when it does not, nothing changes. */
export class ProviderRefundUnavailable extends SettlementsException {
  constructor() {
    super('ProviderRefundUnavailable', 'The payment provider did not accept the refund');
  }
}

export class OnlyTheOwnerMayChangeFeePolicy extends SettlementsException {
  constructor() {
    super('OnlyTheOwnerMayChangeFeePolicy', "Only the owner of the group may say who bears the provider's fee");
  }
}

export class InvalidFeePolicy extends SettlementsException {
  constructor() {
    super('InvalidFeePolicy', "The provider's fee is borne by the payer, the payee or both, shared");
  }
}

export class ProviderFeeInvalid extends SettlementsException {
  constructor() {
    super('ProviderFeeInvalid', "The payment provider's fee is a whole number, 0 or more, less than the amount");
  }
}
