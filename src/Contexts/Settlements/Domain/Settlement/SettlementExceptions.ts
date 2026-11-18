import { Exception, NotAllowedException, NotFoundException, UnauthenticatedException } from '@Architecture/Domain';

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

/** Only the payee of a settlement may refund it: `403` to a signed-in member who is not the payee (request 15). */
export class RefundNotPayeeException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the payee of a settlement may refund it');
  }
}

/**
 * The settlement cannot be refunded as it stands: it is a cash settlement, or a payment through the provider that is not `paid` (still
 * pending, failed, refunding or refunded): `422`, nothing changes (request 15).
 */
export class SettlementNotRefundableException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'SettlementNotRefundable',
      message: 'Only a settlement paid through the provider, and not refunded yet, can be refunded',
    });
  }
}

/**
 * The payer or the payee of the settlement is no longer a member of the group: `422`, nothing changes, so that the balances of the
 * group still add up to 0 (request 15, as an expense that concerns a former member is not changed: request 9).
 */
export class RefundPartyLeftException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'RefundPartyLeft',
      message: 'A settlement whose payer or payee has left the group cannot be refunded',
    });
  }
}

/**
 * The provider did not accept the refund: it answered anything but `201 { id }`, did not answer within 5 seconds, or none is
 * configured. Nothing changes; the settlement stays paid (request 15).
 */
export class RefundUnavailableException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'RefundUnavailable',
      message: 'The payment provider did not accept the refund: nothing changed, try again later',
    });
  }
}

/** Only the payee of a settlement may contest it: `403` to a signed-in member who is not the payee (request 33). */
export class ContestNotPayeeException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the payee of a settlement may contest it');
  }
}

/**
 * The settlement cannot be contested as it stands: it is not a payment through the provider that is `paid`, or it was contested before
 * (a settlement is contested at most once): `422`, nothing changes (request 33).
 */
export class SettlementNotContestableException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'SettlementNotContestable',
      message: 'Only a settlement paid through the provider, and not contested before, can be contested',
    });
  }
}

/**
 * The payer or the payee of the settlement is no longer a member of the group: `422`, nothing changes, so that a settlement the balances do
 * not count never leaves a former member's balance (request 33, as a refund: request 15).
 */
export class ContestPartyLeftException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'ContestPartyLeft',
      message: 'A settlement whose payer or payee has left the group cannot be contested',
    });
  }
}

/** Only an administrator decides a contested settlement: `403` to a signed-in caller who is not one (request 33). */
export class NotAnAdministratorException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only an administrator may decide a contested settlement');
  }
}

/** The contested settlements are not there for the caller: `404` to anyone who is not an administrator (request 33). */
export class ContestsNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No contested settlements are there for you');
  }
}

/** Only a contested settlement is decided, and only once: `422`, nothing changes (request 33). */
export class SettlementNotContestedException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'SettlementNotContested',
      message: 'Only a contested settlement can be decided, once',
    });
  }
}
