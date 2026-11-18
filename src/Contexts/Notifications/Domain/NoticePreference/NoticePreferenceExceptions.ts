import { Exception } from '@Architecture/Domain';

/** A notice preference is for one of the kinds of notice, turned on or off, by a boolean (request 36). */
export class InvalidNoticePreferenceException extends Exception {
  constructor(message: string) {
    super({ service: 'Notifications', type: 'InvalidNoticePreference', message });
  }
}
