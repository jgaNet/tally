import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { UnknownNoticeKindException } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferenceExceptions';

/** The kinds of notice a person may turn on or off, in the order the API lists them (request 36). */
export const NOTICE_KINDS: readonly NoticeKind[] = ['expense', 'reminder', 'budget'];

/** Whether a value names a kind of notice (the domain decides it: the transport checks only its shape, ADR 4). */
export const isNoticeKind = (value: string): value is NoticeKind => (NOTICE_KINDS as readonly string[]).includes(value);

export type NoticePreferenceChangedPayload = {
  preferencesId: string;
  ownerId: string;
  kind: NoticeKind;
  enabled: boolean;
  at: string;
};

/** A person turned a kind of notice on or off (request 36). Made durable with the preferences, in the same transaction. */
export class NoticePreferenceChangedEvent extends DomainEvent<NoticePreferenceChangedPayload> {}

/** The preferences as the store keeps them: the person, the kinds they have turned off, and the version they are at. */
export interface NoticePreferencesSnapshot {
  readonly id: string;
  readonly ownerId: string;
  readonly off: readonly NoticeKind[];
  readonly version: number;
}

/**
 * What a person has turned off, for each kind of notice (request 36, the storm's NoticePreferences, ADR 31): one per person. Every kind
 * is on until it is turned off, and may be turned on again. A notice of a kind turned off is not made for the person; a change is
 * recorded as NoticePreferenceChanged, and nothing else is: what the preferences say of a notice already made does not change.
 *
 * The time is given. Only a change is recorded: turning a kind on that is on already changes nothing and is not saved.
 */
export class NoticePreferences extends AggregateRoot {
  readonly #ownerId: string;
  readonly #off: Set<NoticeKind>;
  #changed = false;

  private constructor(id: Id, version: number, ownerId: string, off: readonly NoticeKind[]) {
    super(id, version);
    this.#ownerId = ownerId;
    this.#off = new Set(off);
  }

  /** The preferences of a person who has changed none: every kind on. Its identity is generated here (DOMAIN-IDENTITY). */
  static create({ ownerId }: { ownerId: string }): NoticePreferences {
    return new NoticePreferences(Id.generate(), 0, ownerId, []);
  }

  /** The preferences as the store keeps them. Records nothing. */
  static fromSnapshot({ id, ownerId, off, version }: NoticePreferencesSnapshot): NoticePreferences {
    return new NoticePreferences(new Id(id), version, ownerId, off);
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  /** Whether this change altered the preferences: the store saves them, and their fact is published, only then. */
  get changed(): boolean {
    return this.#changed;
  }

  /** Whether a notice of this kind is made for the person: a kind is on until it is turned off. */
  isOn(kind: NoticeKind): boolean {
    return !this.#off.has(kind);
  }

  /**
   * Turns a kind on or off for the person. A kind that is not one of the kinds of notice is refused and nothing changes; a kind already in
   * the state asked for changes nothing and records nothing.
   */
  set(kind: string, enabled: boolean, now: Date): IResult<void> {
    if (!isNoticeKind(kind)) return Result.fail(new UnknownNoticeKindException(kind));
    if (this.isOn(kind) === enabled) return Result.ok(undefined);
    if (enabled) this.#off.delete(kind);
    else this.#off.add(kind);
    this.#changed = true;
    this.record(
      NoticePreferenceChangedEvent.set({
        preferencesId: this._id.value,
        ownerId: this.#ownerId,
        kind,
        enabled,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  toSnapshot(): NoticePreferencesSnapshot {
    return {
      id: this._id.value,
      ownerId: this.#ownerId,
      off: NOTICE_KINDS.filter(kind => this.#off.has(kind)),
      version: this.version,
    };
  }
}
