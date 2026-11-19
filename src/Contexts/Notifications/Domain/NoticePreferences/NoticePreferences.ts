import { AggregateRoot, Id } from '@Architecture/Domain';

import { NOTICE_KINDS, NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticePreferenceChangedEvent } from './NoticePreferencesEvents';

/** A person's preferences as they are stored: whether each kind of notice is on, and the version they were read at. */
export interface NoticePreferencesSnapshot {
  id: string;
  memberId: string;
  enabled: Record<NoticeKind, boolean>;
  version: number;
}

/**
 * One person's choice, kind by kind, whether they receive each kind of notice (request 36, ADR 34). Every kind is on until they turn it
 * off, so a person who has changed none has none stored: `defaults` is that state, all on, and records nothing. A change records
 * `NoticePreferenceChanged`; setting a kind to the value it has changes nothing. It carries the version it was read at, and its repository
 * refuses to save it over a newer one (CONC-OPTIMISTIC).
 */
export class NoticePreferences extends AggregateRoot {
  readonly #memberId: string;
  readonly #enabled: Record<NoticeKind, boolean>;

  private constructor(id: Id, version: number, memberId: string, enabled: Record<NoticeKind, boolean>) {
    super(id, version);
    this.#memberId = memberId;
    this.#enabled = { ...enabled };
  }

  /**
   * The preferences of a person who has changed none: every kind on. Its id is born here, and it is stored with the first change.
   * Records nothing: nothing is changed until the person does.
   */
  static defaults(memberId: string): NoticePreferences {
    return new NoticePreferences(Id.generate(), 0, memberId, allOn());
  }

  /** Rebuilds the preferences as they are stored. Records nothing; throws on data no change could have stored. */
  static fromSnapshot({ id, memberId, enabled, version }: NoticePreferencesSnapshot): NoticePreferences {
    if (!Number.isInteger(version) || version < 1 || NOTICE_KINDS.some(kind => typeof enabled[kind] !== 'boolean')) {
      throw new Error(`The stored notice preferences ${id} are corrupted`);
    }
    return new NoticePreferences(new Id(id), version, memberId, enabled);
  }

  get memberId(): string {
    return this.#memberId;
  }

  /** Whether notices of this kind are made for the person. */
  isOn(kind: NoticeKind): boolean {
    return this.#enabled[kind];
  }

  /** The kind is on or off from `at`. Records `NoticePreferenceChanged` when that changes it; the same value again changes nothing. */
  set(kind: NoticeKind, enabled: boolean, at: Date): void {
    if (this.#enabled[kind] === enabled) return;
    this.#enabled[kind] = enabled;
    this.record(NoticePreferenceChangedEvent.set({ memberId: this.#memberId, kind, enabled, at: at.toISOString() }));
  }

  toSnapshot(): NoticePreferencesSnapshot {
    return { id: this._id.value, memberId: this.#memberId, enabled: { ...this.#enabled }, version: this.version };
  }
}

/** Every kind on: the state of a person who has turned none off. */
const allOn = (): Record<NoticeKind, boolean> => ({ expense: true, reminder: true, budget: true });
