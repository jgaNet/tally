import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';

/** Notifications' read side of notice preferences: each kind of a person's, in the order the kinds are read, on or off. */
export interface INoticePreferenceQueries {
  ofOwner(ownerId: string): Promise<NoticePreferenceReadModel[]>;
}
