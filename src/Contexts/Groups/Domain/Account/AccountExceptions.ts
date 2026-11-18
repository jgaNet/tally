import { ConflictException, Exception } from '@Architecture/Domain';

/** An account already uses this email, whatever its case (the email is kept lowercase). */
export class EmailAlreadyRegisteredException extends ConflictException {
  constructor() {
    super({ service: 'Groups', type: 'EmailAlreadyRegistered', message: 'An account already uses this email' });
  }
}

/** The name is not 1 to 60 characters, or is only spaces. */
export class InvalidAccountNameException extends Exception {
  constructor() {
    super({
      service: 'Groups',
      type: 'InvalidAccountName',
      message: 'The name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** The password has fewer than 8 characters. */
export class PasswordTooShortException extends Exception {
  constructor() {
    super({ service: 'Groups', type: 'PasswordTooShort', message: 'The password has at least 8 characters' });
  }
}

/** The account owns a group that has another member: it cannot be deleted until that group is its own alone (request 35). */
export class OwnsGroupWithMembersException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'OwnsGroupWithMembers',
      message: 'You own a group that has other members: you cannot delete your account while you do',
    });
  }
}

/** A payment through the provider this account pays or receives has not ended: the account cannot be deleted while it waits (request 35). */
export class DeletionPaymentWaitingException extends ConflictException {
  constructor() {
    super({
      service: 'Groups',
      type: 'PaymentWaiting',
      message: 'You can delete your account once the payments you make or receive through the provider have ended',
    });
  }
}
