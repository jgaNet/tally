import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Account aggregate and its value objects make. */
export abstract class AccountException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Groups', type, message, context });
  }
}

export class EmailAlreadyUsed extends AccountException {
  constructor() {
    super('EmailAlreadyUsed', 'An account already uses this email');
  }
}

export class InvalidPassword extends AccountException {
  constructor(minLength: number) {
    super('InvalidPassword', `The password must have at least ${minLength} characters`);
  }
}

export class InvalidAccountName extends AccountException {
  constructor(maxLength: number) {
    super('InvalidAccountName', `The name must have 1 to ${maxLength} characters, and not only spaces`);
  }
}

export class InvalidCredentials extends AccountException {
  constructor() {
    super('InvalidCredentials', 'The email or the password is wrong');
  }
}

export class AccountOwnsAGroupWithMembers extends AccountException {
  constructor() {
    super('AccountOwnsAGroupWithMembers', 'An account is deleted once it owns no group that has another member');
  }
}
