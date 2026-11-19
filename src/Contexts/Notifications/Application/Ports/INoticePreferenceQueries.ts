import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';

export interface INoticePreferenceQueries {
  /** The three kinds of notice of one person, in the order they are read (expense, reminder, budget), each on unless turned off. */
  preferencesOf(memberId: string): Promise<NoticePreferenceReadModel[]>;
}
