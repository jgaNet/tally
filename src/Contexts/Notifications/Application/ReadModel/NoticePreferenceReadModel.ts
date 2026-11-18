import { NoticeKind } from '@Contexts/Notifications/Domain/NoticePreferences/NoticeKind';

/** One kind of notice, and whether the person receives it (request 36). */
export interface NoticePreferenceReadModel {
  kind: NoticeKind;
  enabled: boolean;
}
