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

/** The payment provider did not answer a payment link: it answered another way, did not answer within 5 seconds, or is not configured. */
export class ProviderUnavailableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'ProviderUnavailable',
      message: 'The payment provider did not answer as asked',
    });
  }
}

/** The payee has no payout account at the provider, so no payment through the provider is asked for them (request 16). */
export class PayeeHasNoPayoutAccountException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'PayeeHasNoPayoutAccount',
      message: 'The payee has no payout account, so the payment through the provider is not asked',
    });
  }
}

/** The settlement cannot be refunded: it is not a payment through the provider, it is not paid, or its payer or payee is no longer a member. */
export class SettlementNotRefundableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotRefundable',
      message: 'Only a payment through the provider that is paid, between two members of the group, is refunded',
    });
  }
}

/** The settlement cannot be contested: it is not a payment through the provider that is paid, it was contested before, or its payer or payee is no longer a member (request 33). */
export class SettlementNotContestableException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotContestable',
      message:
        'Only a payment through the provider that is paid and never contested, between two members of the group, is contested',
    });
  }
}

/** The settlement is not contested, so an administrator has nothing to decide (request 33). */
export class SettlementNotContestedException extends Exception {
  constructor() {
    super({
      service: 'Settlements',
      type: 'SettlementNotContested',
      message: 'Only a contested settlement is decided',
    });
  }
}
