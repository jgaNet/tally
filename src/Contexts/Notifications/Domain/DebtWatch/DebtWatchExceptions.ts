import { Exception } from '@Architecture/Domain';

/** A debt watch is for a member of a group. */
export class InvalidDebtWatchException extends Exception {
  constructor(message: string) {
    super({ service: 'Notifications', type: 'InvalidDebtWatch', message });
  }
}
