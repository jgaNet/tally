import { Exception } from '@Architecture/Domain';

/** The name is 1 to 60 characters, and not only spaces (after trimming). */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'The name must have 1 to 60 characters, and not only spaces',
    });
  }
}

/** The currency is one of the ten the group may be in (request 2, request 40): EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD, BHD. */
export class InvalidCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidCurrency',
      message: 'The currency must be one of EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD, BHD',
    });
  }
}

/** The account is a member of the group already: it joins once. */
export class AlreadyMemberException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AlreadyMember',
      message: 'You are a member of this group already',
    });
  }
}

/** The owner created the group and stays in it: the owner cannot leave it (request 9). */
export class OwnerCannotLeaveException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnerCannotLeave',
      message: 'The owner of a group cannot leave it',
    });
  }
}

/** The owner archives a group only once every member's balance is 0 (request 27). */
export class BalancesNotSettledException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'BalancesNotSettled',
      message: 'The group can be archived only once every balance is 0',
    });
  }
}

/** The owner archives a group only while no payment through the provider is pending or being refunded (request 27). */
export class PaymentsWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentsWaiting',
      message: 'The group cannot be archived while a payment through the provider is pending or being refunded',
    });
  }
}

/** A member of a group whose payment through the provider is waiting, pending or being refunded, cannot leave until it has ended (request 20). */
export class PaymentWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentWaiting',
      message: 'You cannot leave the group while a payment of yours through the provider is waiting',
    });
  }
}

/** The two groups of a merge are one group: a group is not merged into itself (request 31). */
export class SameGroupException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'SameGroup',
      message: 'A group cannot be merged into itself',
    });
  }
}

/** The two groups of a merge are in different currencies: only groups in one currency are merged (request 31). */
export class CurrenciesDifferException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'CurrenciesDiffer',
      message: 'Only groups in the same currency can be merged',
    });
  }
}

/** A group whose payment through the provider is pending or being refunded is not merged while it is (request 31). */
export class MergePaymentsWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentsWaiting',
      message:
        'The group merged cannot be merged while a payment through the provider is pending or being refunded in it',
    });
  }
}
