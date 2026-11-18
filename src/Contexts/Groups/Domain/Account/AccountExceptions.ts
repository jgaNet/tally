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

export class InvalidName extends AccountException {
  constructor() {
    super('InvalidName', 'A name has 1 to 60 characters and is not only spaces');
  }
}

export class PasswordTooShort extends AccountException {
  constructor(minimum: number) {
    super('PasswordTooShort', `A password has at least ${minimum} characters`);
  }
}

/** A wrong password and an email no account has are the same refusal: nobody learns which emails have accounts. */
export class InvalidCredentials extends AccountException {
  constructor() {
    super('InvalidCredentials', 'The email or the password is wrong');
  }
}

/** An account that owns a group another member is in is not deleted: the group would be left with an owner who is no one (request 35). */
export class OwnsAGroupWithOtherMembers extends AccountException {
  constructor() {
    super('OwnsAGroupWithOtherMembers', 'An account that owns a group with other members cannot be deleted');
  }
}

/** An account with a payment through the provider pending, being refunded or contested is not deleted: it would change a balance once it lands (request 35). */
export class PaymentWaitingAtTheProvider extends AccountException {
  constructor() {
    super('PaymentWaitingAtTheProvider', 'An account with a payment waiting at the provider cannot be deleted');
  }
}
