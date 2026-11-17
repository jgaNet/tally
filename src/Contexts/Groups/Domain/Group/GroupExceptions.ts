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

/** A currency that is not one of the six a group may be in: `422` (ADR 5). */
export class UnsupportedCurrencyException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'UnsupportedCurrency',
      message: 'A group is in one of EUR, USD, GBP, CHF, CAD or AUD',
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

/** A member asks to leave a group while their balance in it is not 0: `422`, a rule (feature 9, ADR 4). */
export class BalanceNotZeroException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'BalanceNotZero',
      message: 'You can leave a group once your balance in it is 0',
    });
  }
}
