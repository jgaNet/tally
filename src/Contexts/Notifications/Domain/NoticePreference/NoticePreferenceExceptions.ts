import { Exception } from '@Architecture/Domain';

/** The kind named is not a kind of notice: `422`, and nothing is changed (request 36). */
export class UnknownNoticeKindException extends Exception {
  constructor(kind: string) {
    super({
      service: 'Notifications',
      type: 'UnknownNoticeKind',
      message: `There is no kind of notice named "${kind}": the kinds are expense, reminder and budget`,
    });
  }
}
