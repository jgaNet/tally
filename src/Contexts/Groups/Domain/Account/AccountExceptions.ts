import { ConflictException, Exception, NotFoundException, UnauthenticatedException } from '@Architecture/Domain';

const SERVICE = 'Groups';

/** A name that is empty, only spaces, or longer than 60 characters: `422` (ADR 4). */
export class InvalidNameException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidName',
      message: 'A name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** A password shorter than 8 characters: `422`. */
export class WeakPasswordException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'WeakPassword', message: 'A password has at least 8 characters' });
  }
}

/** An account already uses this email, whatever its case: `409`. */
export class EmailAlreadyRegisteredException extends ConflictException {
  constructor() {
    super(SERVICE, 'EmailAlreadyRegistered', 'An account already uses this email');
  }
}

/**
 * The email or the password is wrong, or no account has the email: the same answer for both, so nobody learns which
 * emails have accounts. `401` on every route (ADR 4).
 */
export class InvalidCredentialsException extends UnauthenticatedException {
  constructor() {
    super(SERVICE, 'InvalidCredentials', 'The email or the password is wrong');
  }
}

/** The signed-in account is not there: `404`. */
export class AccountNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No account is signed in as this one');
  }
}

/** The account an administrator names is not there: `404` (request 34). */
export class NoSuchAccountException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No account is there with this id');
  }
}
