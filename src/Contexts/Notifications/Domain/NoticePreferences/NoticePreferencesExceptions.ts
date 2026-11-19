import { Exception } from '@Architecture/Domain';

/** A kind of notice that is none of the three (request 36): `expense`, `reminder` or `budget`. */
export class InvalidNoticeKindException extends Exception {
  constructor() {
    super({
      service: 'Notifications',
      type: 'InvalidNoticeKind',
      message: 'The kind must be one of expense, reminder, budget',
    });
  }
}
