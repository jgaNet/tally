import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Group aggregate and its value objects make. */
export abstract class GroupException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Groups', type, message, context });
  }
}

export class InvalidGroupName extends GroupException {
  constructor(maxLength: number) {
    super('InvalidGroupName', `The name must have 1 to ${maxLength} characters, and not only spaces`);
  }
}

export class InvalidCurrency extends GroupException {
  constructor(currencies: readonly string[]) {
    super('InvalidCurrency', `The currency must be one of ${currencies.join(', ')}`);
  }
}

export class AlreadyMember extends GroupException {
  constructor() {
    super('AlreadyMember', 'This account is already a member of the group');
  }
}

export class NotAMember extends GroupException {
  constructor() {
    super('NotAMember', 'This account is not a member of the group');
  }
}

export class OwnerCannotLeave extends GroupException {
  constructor() {
    super('OwnerCannotLeave', 'The owner cannot leave the group they created');
  }
}

export class BalanceNotZero extends GroupException {
  constructor() {
    super('BalanceNotZero', 'A member leaves a group only once their balance in it is 0');
  }
}
