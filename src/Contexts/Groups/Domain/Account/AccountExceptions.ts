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
