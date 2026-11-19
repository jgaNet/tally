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
    super('InvalidCurrency', 'A currency is one of EUR, USD, GBP, CHF, CAD, AUD, JPY, KRW, KWD or BHD');
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

/** Only the owner of a group may archive it. */
export class OnlyTheOwnerMayArchive extends GroupException {
  constructor() {
    super('OnlyTheOwnerMayArchive', 'Only the owner of a group may archive it');
  }
}

/** A group is archived once every balance in it is 0: one that is not is still owed. */
export class BalancesNotSettled extends GroupException {
  constructor() {
    super('BalancesNotSettled', 'A group can be archived only once every balance in it is 0');
  }
}

/** A group is not archived while a payment in it is waiting at the provider (pending or being refunded). */
export class ArchiveWaitsForPayment extends GroupException {
  constructor() {
    super('ArchiveWaitsForPayment', 'A group cannot be archived while a payment in it is waiting at the provider');
  }
}

/** A member cannot leave while a payment they pay or receive through the provider is pending or being refunded (request 20). */
export class PaymentWaitingAtProvider extends GroupException {
  constructor() {
    super(
      'PaymentWaitingAtProvider',
      'You cannot leave this group while a payment you pay or receive is waiting at the provider',
    );
  }
}

/** Only the owner of both groups may merge one into the other (request 31). */
export class OnlyTheOwnerMayMerge extends GroupException {
  constructor() {
    super('OnlyTheOwnerMayMerge', 'Only the owner of both groups may merge one into the other');
  }
}

/** A group is not merged into itself. */
export class MergeIntoItself extends GroupException {
  constructor() {
    super('MergeIntoItself', 'A group cannot be merged into itself');
  }
}

/** Two groups are merged only when they are in the same currency. */
export class CurrenciesDiffer extends GroupException {
  constructor() {
    super('CurrenciesDiffer', 'Two groups are merged only when they are in the same currency');
  }
}

/** A group is not merged while a payment in it is waiting at the provider (pending or being refunded). */
export class MergeWaitsForPayment extends GroupException {
  constructor() {
    super('MergeWaitsForPayment', 'A group cannot be merged while a payment in it is waiting at the provider');
  }
}
