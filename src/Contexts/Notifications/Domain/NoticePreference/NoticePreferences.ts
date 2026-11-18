import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import {
  INoticePreferencesSnapshot,
  NOTICE_KINDS,
  NoticePreferenceKind,
} from '@Contexts/Notifications/Domain/NoticePreference/DTOs';
import { NoticePreferenceChangedEvent } from '@Contexts/Notifications/Domain/NoticePreference/Events/NoticePreferenceEvents';
import { InvalidNoticePreferenceException } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferenceExceptions';

/**
 * NoticePreferences is the aggregate root of one person's choice of notices (request 36, the storm `notice-preferences`): for each
 * kind of notice, on or off. Every kind is on until the person turns it off, and may be turned on again. It holds only the kinds
 * turned off, so a person who never chose has every kind on, and nothing is stored for them.
 *
 * The preferences decide nothing about a notice already made: they are read when a notice would be made, by the reaction to the fact
 * or by the sweep, and a notice of a kind turned off is not made from then on. Changing a kind to the value it already has changes
 * nothing and records nothing.
 */
export class NoticePreferences extends AggregateRoot {
  readonly #person: string;
  readonly #off: Set<NoticePreferenceKind>;

  private constructor(id: Id, person: string, off: NoticePreferenceKind[], version: number) {
    super(id, version);
    this.#person = person;
    this.#off = new Set(off);
  }

  /** The preferences of a person who has none yet: every kind on, its id generated here; nothing is recorded until one is turned. */
  static open(person: string): NoticePreferences {
    return new NoticePreferences(Id.generate(), person, [], 0);
  }

  /** The preferences as the store holds them. Records nothing; throws on preferences no rule could have made. */
  static fromSnapshot({ _id, person, off, version }: INoticePreferencesSnapshot): NoticePreferences {
    const kinds = new Set(off);
    if (!person || !off.every(isKind) || kinds.size !== off.length) {
      throw new Error(`Corrupted notice preferences ${_id}`);
    }
    return new NoticePreferences(new Id(_id), person, off, version);
  }

  /**
   * Turns `kind` on or off for the person (request 36). A kind that is not one of the three, or a value that is not a boolean, is
   * refused and changes nothing. A kind set to the value it already has changes nothing; a change is recorded as
   * NoticePreferenceChanged.
   */
  set({ kind, enabled }: { kind: string; enabled: boolean }): IResult<void> {
    if (!isKind(kind)) return Result.fail(new InvalidNoticePreferenceException('A notice is of a kind this app makes'));
    if (typeof enabled !== 'boolean')
      return Result.fail(new InvalidNoticePreferenceException('A notice kind is on or off'));

    if (this.wants(kind) === enabled) return Result.ok();
    if (enabled) this.#off.delete(kind);
    else this.#off.add(kind);
    this.record(NoticePreferenceChangedEvent.set({ person: this.#person, kind, enabled }));
    return Result.ok();
  }

  /** Whether a notice of `kind` is made for this person: on unless they have turned it off. */
  wants(kind: NoticePreferenceKind): boolean {
    return !this.#off.has(kind);
  }

  get person(): string {
    return this.#person;
  }

  toSnapshot(): INoticePreferencesSnapshot {
    return {
      _id: this._id.value,
      person: this.#person,
      off: NOTICE_KINDS.filter(kind => this.#off.has(kind)),
      version: this.version,
    };
  }
}

function isKind(kind: unknown): kind is NoticePreferenceKind {
  return (NOTICE_KINDS as readonly unknown[]).includes(kind);
}
