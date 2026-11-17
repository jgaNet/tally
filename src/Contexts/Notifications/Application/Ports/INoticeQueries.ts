import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';

/** Notifications' read side of notices: the ones made for a person, the most recent first. */
export interface INoticeQueries {
  ofRecipient(recipientId: string): Promise<NoticeReadModel[]>;
}
