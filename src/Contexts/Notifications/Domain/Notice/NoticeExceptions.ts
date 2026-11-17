import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Notifications context makes. */
export abstract class NoticesException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Notifications', type, message, context });
  }
}

/** A notice's amount is a whole number, at least 0: a member's share of an expense. */
export class InvalidNoticeAmount extends NoticesException {
  constructor() {
    super('InvalidNoticeAmount', 'An amount is a whole number, at least 0');
  }
}
