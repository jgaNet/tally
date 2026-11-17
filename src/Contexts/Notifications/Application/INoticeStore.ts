import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/** The notices this context keeps, written by the reaction that makes them: Notifications' own port, over its own table. */
export interface INoticeStore {
  add(notice: Notice): Promise<void>;
}
