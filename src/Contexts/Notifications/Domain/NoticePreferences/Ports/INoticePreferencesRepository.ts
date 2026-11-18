import { IResult } from '@Architecture/Domain';

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';

export interface INoticePreferencesRepository {
  /**
   * A person's preferences as the transaction reads them, or null when they never turned a kind of notice on or off (every kind is
   * on then). A reaction that would make a notice reads them in its own transaction.
   */
  findByOwner(ownerId: string): Promise<NoticePreferences | null>;
  /**
   * Stores the preferences at the version they were read at: a new one is inserted, an existing one is updated only while it is still
   * at that version. Otherwise the save is a ConcurrencyConflictException, which the command's bus reads and decides again.
   */
  save(preferences: NoticePreferences): Promise<IResult>;
}
