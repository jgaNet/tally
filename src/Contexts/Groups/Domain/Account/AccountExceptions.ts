import { AlreadyExistsException, Exception } from '@Architecture/Domain';

/** The name is empty, only spaces, or longer than 60 characters. */
export class InvalidAccountNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidAccountName',
      message: 'An account has a name of 1 to 60 characters, that is not only spaces',
    });
  }
}

/** The password is shorter than 8 characters. */
export class PasswordTooShortException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'PasswordTooShort',
      message: 'A password has at least 8 characters',
    });
  }
}

/** An account already uses this email, whatever its case: the email is the account's key. */
export class EmailAlreadyUsedException extends AlreadyExistsException {
  constructor() {
    super('Groups', 'An account already uses this email');
    this.type = 'EmailAlreadyUsed';
  }
}

/** An account that owns a group with another member is not deleted: the group would be left without its owner (request 35, docs/adr/0035). */
export class OwnsGroupWithMembersException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnsGroupWithMembers',
      message: 'An account that owns a group with another member is deleted once it owns none',
    });
  }
}

/** An account is not deleted while a payment of its waits at the provider: pending, refunding or contested (request 35, docs/adr/0035). */
export class AccountPaymentWaitingException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'AccountPaymentWaiting',
      message: 'An account is deleted once no payment of its waits at the provider',
    });
  }
}
