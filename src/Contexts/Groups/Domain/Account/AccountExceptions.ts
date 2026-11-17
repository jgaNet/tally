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
