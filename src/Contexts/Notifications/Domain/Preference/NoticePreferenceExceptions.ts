import { Exception } from '@Architecture/Domain';

/** The kind named in the route is not one of the three kinds of notice (request 36): a refusal, not a server error. */
export class InvalidNoticeKindException extends Exception {
  constructor() {
    super({
      service: 'Notifications',
      type: 'InvalidNoticeKind',
      message: 'A kind of notice is expense, reminder or budget',
    });
  }
}
