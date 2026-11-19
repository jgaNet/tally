import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';

/**
 * The preferences of the people, as aggregates, one per person (request 36, ADR 34). A person's preferences are loaded at the version
 * they were stored at, and written only over that version: a save over a newer one is refused with a ConcurrencyConflictException
 * (CONC-OPTIMISTIC). The reactions and the sweep ask it which members have a kind of notice turned off, and make none of it for them.
 */
export interface INoticePreferenceRepository {
  /** A person's preferences as they are stored, or, for a person who has changed none, every kind on. */
  of(memberId: string): Promise<NoticePreferences>;
  /** Writes a person's preferences over the version they were read at. */
  save(preferences: NoticePreferences): Promise<void>;
  /** Of the members given, those who have the kind of notice turned off; a member not in the answer has it on. */
  turnedOff(kind: NoticeKind, memberIds: readonly string[]): Promise<Set<string>>;
  /** Runs `work` in one transaction on the store, so what it reads and writes is one state (ADR 17). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
