import { Exception } from '@Architecture/Domain';

/** `startsOn` is a real day, whose day of the month is from 1 to 28, and no more than 365 days from today (UTC). */
export class InvalidRecurringStartsOnException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidRecurringStartsOn',
      message:
        'startsOn must be a real day, written YYYY-MM-DD, whose day of the month is from 1 to 28, and no more than 365 days before or after today (UTC)',
    });
  }
}
