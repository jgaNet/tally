import { INoticePreferenceStore } from '@Contexts/Notifications/Application/INoticePreferenceStore';
import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

/** An in-memory store of notice preferences for the unit tests: every kind on unless a test turns it off for a person. */
export class MemoryNoticePreferences implements INoticePreferenceStore {
  readonly #off = new Map<string, NoticeKind[]>();

  /** Turns a kind off for a person, as a committed change would have: the next read sees it. */
  turnOff(ownerId: string, kind: NoticeKind): void {
    this.#off.set(ownerId, [...new Set([...(this.#off.get(ownerId) ?? []), kind])]);
  }

  /** Turns a kind on again for a person. */
  turnOn(ownerId: string, kind: NoticeKind): void {
    this.#off.set(
      ownerId,
      (this.#off.get(ownerId) ?? []).filter(off => off !== kind),
    );
  }

  async preferencesOf(ownerId: string): Promise<NoticePreferences> {
    const off = this.#off.get(ownerId) ?? [];
    return NoticePreferences.fromSnapshot({ id: `prefs-${ownerId}`, ownerId, off, version: off.length ? 1 : 0 });
  }

  async save(preferences: NoticePreferences): Promise<void> {
    const snapshot = preferences.toSnapshot();
    this.#off.set(snapshot.ownerId, [...snapshot.off]);
  }
}
