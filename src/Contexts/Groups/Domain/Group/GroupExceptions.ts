import { Exception } from '@Architecture/Domain';

/** The name is empty, only spaces, or longer than 60 characters. */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'A group has a name of 1 to 60 characters, that is not only spaces',
    });
  }
}

/** The currency is not one of the ten a group may be in (request 40). */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD or BHD',
    });
  }
}

/** The owner created the group and stays in it: its owner cannot leave it (request 9). */
export class OwnerCannotLeaveException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnerCannotLeave',
      message: 'The owner of a group cannot leave it',
    });
  }
}

/** A member does not leave while a payment of theirs waits at the provider: pending or refunding (request 20, docs/adr/0019). */
export class PaymentWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentWaiting',
      message: 'A member leaves a group once no payment of theirs waits at the provider',
    });
  }
}

/** A group is archived once every balance in it is 0: a member's balance is not, and the owner archives it no sooner (request 27). */
export class BalancesNotZeroException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'BalancesNotZero',
      message: 'A group is archived once every balance in it is 0',
    });
  }
}

/** A group is merged into another, not into itself (request 31). */
export class MergeIntoItselfException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'MergeIntoItself',
      message: 'A group is merged into another group, not into itself',
    });
  }
}

/** Two groups are merged once they are in the same currency (request 31, docs/adr/0031). */
export class CurrenciesDifferException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'CurrenciesDiffer',
      message: 'Two groups are merged once they are in the same currency',
    });
  }
}

/** A group is merged once no payment in the group merged waits at the provider: pending or refunding (request 31, docs/adr/0031). */
export class MergePaymentsWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'MergePaymentsWaiting',
      message: 'A group is merged once no payment in it waits at the provider',
    });
  }
}

/** A group is archived once no payment in it waits at the provider: pending or refunding (request 27, docs/adr/0026). */
export class PaymentsWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentsWaiting',
      message: 'A group is archived once no payment in it waits at the provider',
    });
  }
}
