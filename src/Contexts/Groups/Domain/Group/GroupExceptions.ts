import { ConflictException, Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Groups';

/** A group name that is empty, only spaces, or longer than 60 characters: `422` (ADR 4, ADR 5). */
export class InvalidGroupNameException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidGroupName',
      message: 'A group name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/**
 * The group is not there for the caller: it does not exist, or the caller is not one of its members. Both are the same
 * answer, `404`, so nobody learns that a group exists (ADR 5).
 */
export class GroupNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No group is there for you with this id');
  }
}

/** An account that is already a member of the group asks to join it again: `409`, a conflict with what is kept (ADR 4). */
export class AlreadyMemberException extends ConflictException {
  constructor() {
    super(SERVICE, 'AlreadyMember', 'You are already a member of this group');
  }
}

/** The owner of a group asks to leave it: `403`, the owner stays in the group they created (feature 9). */
export class OwnerCannotLeaveException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'The owner of a group cannot leave it');
  }
}

/**
 * A member asks to leave a group while a payment of theirs waits at the provider (pending or refunding, as payer or payee): `422`,
 * a rule. They leave once it has ended (request 20, ADR 15).
 */
export class PaymentWaitingException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'PaymentWaiting',
      message: 'You can leave a group once the payments you pay or receive through the provider have ended',
    });
  }
}

/** A member who is not the owner asks to archive the group: `403`, the owner archives it (feature 27, request 27). */
export class OnlyTheOwnerArchivesException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the owner of the group can archive it');
  }
}

/**
 * The owner asks to archive a group while a balance is not 0, or a payment through the provider is pending or refunding: `422`, a rule.
 * The group is archived once every balance is 0 and nothing waits at the provider (feature 27, request 27).
 */
export class GroupNotSettledException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'GroupNotSettled',
      message:
        'A group is archived once every balance is 0 and no payment through the provider is pending or refunding',
    });
  }
}

/** A member who is not the owner of both groups asks to merge them: `403`, the owner of both merges them (feature 31, request 31). */
export class OnlyTheOwnerMergesException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the owner of both groups can merge them');
  }
}

/** The owner asks to merge a group into itself: `422`, a rule (feature 31, request 31). */
export class CannotMergeIntoItselfException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'CannotMergeIntoItself',
      message: 'A group cannot be merged into itself',
    });
  }
}

/** Two groups of different currencies are merged: `422`, a rule. A group keeps its currency (request 2, feature 31). */
export class CurrencyMismatchException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'CurrencyMismatch',
      message: 'Only groups in the same currency can be merged',
    });
  }
}

/**
 * A group is merged while a payment through the provider in it is pending or refunding: `422`, a rule. The merge waits for the payment to
 * end, as a member's leave does (request 15, feature 31).
 */
export class MergePaymentWaitingException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'MergePaymentWaiting',
      message: 'Groups are merged once the payments through the provider in the group merged have ended',
    });
  }
}
