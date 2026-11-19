import { Exception } from '@Architecture/Domain';

/** The name is 1 to 60 characters, and not only spaces (after trimming). */
export class InvalidAccountNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidAccountName',
      message: 'The name must have 1 to 60 characters, and not only spaces',
    });
  }
}

/** The password has at least 8 characters. */
export class InvalidPasswordException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidPassword',
      message: 'The password must have at least 8 characters',
    });
  }
}

/** An account already uses this email, whatever its case. */
export class EmailAlreadyUsedException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'EmailAlreadyUsed',
      message: 'An account already uses this email',
    });
  }
}

/** The account owns a group with other members: it cannot be deleted while another member is in a group it owns (request 35). */
export class OwnsGroupWithMembersException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnsGroupWithMembers',
      message:
        'You own a group with other members: the group must be left to them, or they must leave it, before you delete your account',
    });
  }
}

/** A payment through the provider of the account is pending, refunding or contested: it cannot be deleted until it has ended (request 35). */
export class AccountPaymentWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountPaymentWaiting',
      message:
        'The account cannot be deleted while a payment of yours through the provider is pending, refunding or contested',
    });
  }
}
