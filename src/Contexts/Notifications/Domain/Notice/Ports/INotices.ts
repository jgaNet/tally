import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/** The store of the notices: saves inside a transaction only (docs/adr/0017). */
export interface INotices {
  /**
   * Stores the notice. A person has one notice per expense: a second for the same person and expense stores nothing and answers
   * `false`, so a fact handed twice after a crash still makes one.
   */
  save(notice: Notice): Promise<boolean>;
}
