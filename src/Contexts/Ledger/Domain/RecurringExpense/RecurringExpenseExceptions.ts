import { Exception, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Ledger';

/**
 * A start that is not a real day of the calendar, whose day of the month is not 1 to 28, or that is more than 365 days before today
 * or after it (UTC): `422` (request 23). The shape of the day is the body's (`400`); its value is the domain's.
 */
export class InvalidRecurringStartsOnException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidRecurringStartsOn',
      message:
        'A recurring expense starts on a real day of the month from 1 to 28, no more than 365 days before today nor after it',
    });
  }
}

/** The recurring expense is not there for the caller: the same `404` for one that does not exist and one of a group they are not in. */
export class RecurringExpenseNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No recurring expense is there for you with this id');
  }
}
