import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/DTOs';

/** The kinds of notice, in the order the API lists them: an expense's, a reminder's, a budget's (request 36). */
export const NOTICE_KINDS: readonly NoticeKind[] = ['expense', 'reminder', 'budget'];

/** Whether a value names one of the kinds of notice: the one check a kind's route asks, before anything is decided. */
export const isNoticeKind = (kind: string): kind is NoticeKind => (NOTICE_KINDS as readonly string[]).includes(kind);

/** A kind of notice and whether the person receives it, as `GetNoticePreferences` answers it (request 36). */
export interface NoticePreferenceView {
  kind: NoticeKind;
  enabled: boolean;
}

/** The preferences as the store keeps them: one row per person, the version it was saved at, and a flag per kind. */
export interface NoticePreferenceSnapshot {
  id: string;
  version: number;
  accountId: string;
  expense: boolean;
  reminder: boolean;
  budget: boolean;
}
