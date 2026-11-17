import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Group aggregate and its value objects make. */
export abstract class GroupException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Groups', type, message, context });
  }
}

export class InvalidGroupName extends GroupException {
  constructor() {
    super('InvalidGroupName', 'A group name has 1 to 60 characters and is not only spaces');
  }
}

export class InvalidCurrency extends GroupException {
  constructor() {
    super('InvalidCurrency', 'A currency is one of EUR, USD, GBP, CHF, CAD or AUD');
  }
}

/** An account that is already a member of the group asks to join it again. */
export class AlreadyAMember extends GroupException {
  constructor() {
    super('AlreadyAMember', 'You are already a member of this group');
  }
}
