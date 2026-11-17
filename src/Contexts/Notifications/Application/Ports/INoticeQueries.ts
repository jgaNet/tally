import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';

export interface INoticeQueries {
  /** The notices of one member, the most recent first (the latest made first; the same instant, the one stored last first). Empty for a member with none. */
  listFor(memberId: string): Promise<NoticeReadModel[]>;
}
