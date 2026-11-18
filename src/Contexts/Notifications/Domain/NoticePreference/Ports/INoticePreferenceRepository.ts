import { IResult } from '@Architecture/Domain';

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

/**
 * The notice preferences, as aggregates: one per person. It loads and saves them. A save is refused with a
 * ConcurrencyConflictException when the preferences are no longer at the version they were read at (CONC-OPTIMISTIC).
 */
export interface INoticePreferenceRepository {
  /** The preferences of the person, or null when they have never turned a kind off or on. */
  findByPerson(person: string): Promise<NoticePreferences | null>;
  save(preferences: NoticePreferences): Promise<IResult>;
}
