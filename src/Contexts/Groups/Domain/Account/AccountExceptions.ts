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
