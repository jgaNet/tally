import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

/**
 * The notice preferences this context keeps: one per person, read by the reactions that would make a notice and by the sweep, and
 * changed by the person who owns them. `preferencesOf` answers the person's preferences as committed, every kind on when none is kept;
 * `save` stores a changed one over the version it was read at, or refuses it with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export interface INoticePreferenceStore {
  preferencesOf(ownerId: string): Promise<NoticePreferences>;
  save(preferences: NoticePreferences): Promise<void>;
}
