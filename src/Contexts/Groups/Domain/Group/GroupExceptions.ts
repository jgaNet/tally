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

/** Only a member of the group may leave it. */
export class NotAMember extends GroupException {
  constructor() {
    super('NotAMember', 'You are not a member of this group');
  }
}

/** The owner created the group and stays in it. */
export class OwnerCannotLeave extends GroupException {
  constructor() {
    super('OwnerCannotLeave', 'The owner of a group cannot leave the group they created');
  }
}

/** A member leaves a group once their balance in it is 0: what they owe or are owed is settled first. */
export class BalanceNotZero extends GroupException {
  constructor() {
    super('BalanceNotZero', 'A member can leave a group only once their balance in it is 0');
  }
}
