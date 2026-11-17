import { Exception, NotFoundException, UnauthenticatedException } from '@Architecture/Domain';

const SERVICE = 'Settlements';

/**
 * The payment provider did not give a payment link: it answered anything but `201 { id, payUrl }`, or did not answer within 5
 * seconds, or none is configured. Nothing is kept: `422`, the request is refused (request 13).
 */
export class ProviderUnavailableException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'ProviderUnavailable',
      message: 'The payment provider did not give a payment link: nothing was kept, try again later',
    });
  }
}

/**
 * The provider's webhook carries no signature, or one that is not the provider's over its body: refused with `401`, and nothing
 * changes (request 13, the caller's proof of who sent it).
 */
export class SignatureNotValidException extends UnauthenticatedException {
  constructor() {
    super(SERVICE, 'SignatureNotValid', 'The webhook is not signed by the payment provider');
  }
}

/** The group is not there for the caller: the same `404` for a group that does not exist and one the caller is not in (request 11). */
export class GroupNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No group is there for you with this id');
  }
}

/** The settlement is not there for the caller: the same `404` for one that does not exist and one of a group they are not in (request 12). */
export class SettlementNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No settlement is there for you with this id');
  }
}

/** An amount that is not a whole number of the group's currency's hundredths, 1 or more: `422` (request 12). */
export class InvalidSettlementAmountException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidSettlementAmount',
      message: 'A settlement amount is a whole number, at least 1',
    });
  }
}

/** The payer is not a member of the group: `422` (request 12). */
export class PayerNotInGroupException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'PayerNotInGroup',
      message: 'Only members of the group can settle with each other',
    });
  }
}

/** The payer is the payee: a member cannot be paid by themselves: `422` (request 12). */
export class PayeeIsPayerException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'PayeeIsPayer',
      message: 'The payer and the payee of a settlement are two members',
    });
  }
}

/** The amount is more than the payer owes in the group, at the moment it is recorded: `422`, nothing changes (request 12). */
export class MoreThanPayerOwesException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'MoreThanPayerOwes', message: 'The settlement is more than the payer owes' });
  }
}

/** The amount is more than the payee is owed in the group, at the moment it is recorded: `422`, nothing changes (request 12). */
export class MoreThanPayeeIsOwedException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'MoreThanPayeeIsOwed', message: 'The settlement is more than the payee is owed' });
  }
}
