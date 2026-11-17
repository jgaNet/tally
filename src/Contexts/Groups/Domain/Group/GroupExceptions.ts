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
      message: 'The currency is one of EUR, USD, GBP, CHF, CAD or AUD',
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
