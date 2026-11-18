import { Exception } from '@Architecture/Domain';

/** The first day is not a real day of the calendar, 1 to 28 in its month, and no more than 365 days from today (request 23). */
export class InvalidStartsOnException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidStartsOn',
      message:
        'A recurring expense starts on a real day, 1 to 28 of its month, no more than 365 days before or after today',
    });
  }
}
