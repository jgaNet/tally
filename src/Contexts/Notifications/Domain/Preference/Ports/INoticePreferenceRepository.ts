import { Id, IResult } from '@Architecture/Domain';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

export interface INoticePreferenceRepository {
  /** The preferences of a person, read in the transaction the caller holds, or null when none were ever changed (all kinds on). */
  findByMember(memberId: Id): Promise<NoticePreferences | null>;
  /** Stores new preferences, or changed ones, in the transaction it is made in; refuses one no longer at the stored version. */
  save(preferences: NoticePreferences): Promise<IResult>;
}
