import { Exception } from '@Architecture/Domain';

/** The base of every refusal the Notice aggregate makes. */
export abstract class NoticeException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Notifications', type, message, context });
  }
}

export class InvalidNoticeAmount extends NoticeException {
  constructor() {
    super('InvalidNoticeAmount', 'The amount of a notice must be a whole number of 0 or more');
  }
}
