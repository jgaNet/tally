import { ConflictException, Exception } from '@Architecture/Domain';

/** The name is not 1 to 60 characters, or is only spaces. */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidGroupName',
      message: 'The name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** The currency is not one of the six a group may be in. */
export class UnsupportedCurrencyException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'UnsupportedCurrency',
      message: 'The currency is one of EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD or BHD',
    });
  }
}

/** The account is already a member of the group: it cannot join it again. */
export class AlreadyMemberException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'AlreadyMember',
      message: 'You are already a member of this group',
    });
  }
}

/** The owner created the group, and cannot leave it. */
export class OwnerCannotLeaveException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnerCannotLeave',
      message: 'The owner of a group cannot leave it',
    });
  }
}

/** A payment the member makes or receives through the provider is still waiting: it leaves once the payment has ended. */
export class PaymentWaitingException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentWaiting',
      message: 'You can leave the group once the payments you make or receive through the provider have ended',
    });
  }
}

/** The group is not settled: a balance is not 0, or a payment through the provider is still waiting; it is archived only once neither is. */
export class GroupNotSettledException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'GroupNotSettled',
      message:
        'Every balance must be 0 and no payment through the provider may be pending or refunding to archive the group',
    });
  }
}

/** The two groups are one and the same: a group is not merged into itself (request 31). */
export class GroupMergeIntoItselfException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'GroupMergeIntoItself',
      message: 'A group cannot be merged into itself',
    });
  }
}

/** The two groups are not in the same currency: a merge keeps one currency, so the groups must share it (request 31). */
export class CurrenciesDifferException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'CurrenciesDiffer',
      message: 'Only groups in the same currency can be merged',
    });
  }
}

/** A payment through the provider in the group merged is still pending or refunding: the merge waits until it has ended (request 31). */
export class GroupMergePaymentWaitingException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'GroupMergePaymentWaiting',
      message: 'The group cannot be merged while a payment through the provider in it is pending or refunding',
    });
  }
}
