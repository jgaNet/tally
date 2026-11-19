import { Exception } from '@Architecture/Domain';

/** The base of every refusal the NoticePreferences aggregate makes. */
export abstract class NoticePreferenceException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Notifications', type, message, context });
  }
}

export class UnknownNoticeKind extends NoticePreferenceException {
  constructor() {
    super('UnknownNoticeKind', 'A kind of notice is one of expense, reminder or budget');
  }
}
