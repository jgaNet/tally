import { NoticeView } from '@Contexts/Notifications/Domain/Notice/DTOs';

/** The read side of the notices (request 17). */
export interface INoticeQueries {
  /** A person's own notices, the most recent first. */
  noticesOf(accountId: string): Promise<NoticeView[]>;
}
