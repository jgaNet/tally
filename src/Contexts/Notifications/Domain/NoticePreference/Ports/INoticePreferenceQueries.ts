import { NoticePreferenceKind } from '@Contexts/Notifications/Domain/NoticePreference/DTOs';

/** A kind of notice as its person reads it (request 36's `noticePreference`): on or off. */
export interface NoticePreferenceView {
  kind: NoticePreferenceKind;
  enabled: boolean;
}

/** The read side of notice preferences: read models, never aggregates (QUERY-READ-MODELS). */
export interface INoticePreferenceQueries {
  /** The kinds of notice of `person`, each on or off, in the order the kinds are declared. */
  ofPerson(person: string): Promise<NoticePreferenceView[]>;
}
