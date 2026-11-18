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

export class PaymentWaitingAtProvider extends GroupException {
  constructor(message?: string) {
    super(
      'PaymentWaitingAtProvider',
      message ?? 'A member leaves a group once no payment of theirs is waiting at the provider',
    );
  }
}

export class OnlyTheOwnerArchives extends GroupException {
  constructor() {
    super('OnlyTheOwnerArchives', 'Only the owner of the group archives it');
  }
}

export class GroupNotSettled extends GroupException {
  constructor() {
    super('GroupNotSettled', "A group is archived once every member's balance is 0");
  }
}

export class OnlyTheOwnerMerges extends GroupException {
  constructor() {
    super('OnlyTheOwnerMerges', 'Only the owner of both groups merges one into the other');
  }
}

export class GroupMergedIntoItself extends GroupException {
  constructor() {
    super('GroupMergedIntoItself', 'A group is merged into another group, not into itself');
  }
}

export class CurrenciesDiffer extends GroupException {
  constructor() {
    super('CurrenciesDiffer', 'Two groups are merged only when they are in the same currency');
  }
}
