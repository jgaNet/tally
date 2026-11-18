import { Exception } from '@Architecture/Domain';

/** The day is not a real day of the calendar, 365 days or less from today either way, whose day of the month is 1 to 28. */
export class InvalidRecurringDayException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidStartsOn',
      message: 'startsOn is a real day, YYYY-MM-DD, at most 365 days from today, whose day of the month is 1 to 28',
    });
  }
}
