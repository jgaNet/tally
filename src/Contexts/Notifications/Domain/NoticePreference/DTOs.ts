/** The kinds of notice a person turns on or off (request 36): an expense's, a reminder's, a budget's. */
export const NOTICE_KINDS = ['expense', 'reminder', 'budget'] as const;

export type NoticePreferenceKind = (typeof NOTICE_KINDS)[number];

/** A person's notice preferences as the store keeps them: the kinds they have turned off, and the version it was read at. */
export interface INoticePreferencesSnapshot {
  _id: string;
  person: string;
  off: NoticePreferenceKind[];
  version: number;
}
