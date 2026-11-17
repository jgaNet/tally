import { Exception } from '@Architecture/Domain';

/** A notice must be for someone, about an expense of a group, with a share that is a whole number of cents; a reminder is for more than 2000 still owed. */
export class InvalidNoticeException extends Exception {
  constructor(message: string) {
    super({ service: 'Notifications', type: 'InvalidNotice', message });
  }
}
