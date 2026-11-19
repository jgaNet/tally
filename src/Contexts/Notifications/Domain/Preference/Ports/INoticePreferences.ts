import { IResult } from '@Architecture/Domain';

import { NoticePreferenceView } from '@Contexts/Notifications/Domain/Preference/DTOs';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

/**
 * The store of a person's notice preferences: used inside a transaction only, by the reactions that make a notice and by the command that
 * sets a kind (docs/adr/0036).
 */
export interface INoticePreferences {
  /** The person's preferences as last saved; a person never set is every kind on (version 0). */
  get(accountId: string): Promise<NoticePreferences>;
  /** Saves at the version read; a save over a newer one answers a conflict, and the command re-reads and decides again (CONC-OPTIMISTIC). */
  save(preferences: NoticePreferences): Promise<IResult<undefined>>;
}

/** The read side of the preferences: a person's own, each kind in the order the API lists them (request 36). */
export interface INoticePreferenceQueries {
  preferencesOf(accountId: string): Promise<NoticePreferenceView[]>;
}
