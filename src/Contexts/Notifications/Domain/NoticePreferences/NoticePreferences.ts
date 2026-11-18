import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeKind, noticeKindOf } from '@Contexts/Notifications/Domain/NoticePreferences/NoticeKind';
import { NoticePreferenceChangedEvent } from '@Contexts/Notifications/Domain/NoticePreferences/Events/NoticePreferenceEvents';

export type NoticeFlags = Record<NoticeKind, boolean>;

/**
 * What one person has turned notices on or off, one flag per kind (request 36). Every kind is on until they turn it off, so a
 * person who never changed anything has no row, and a row keeps every kind's flag. Turning a kind to what it already is records
 * nothing; turning it to the other value records NoticePreferenceChanged, from the time the handler passes (DOMAIN-ONE-CLOCK).
 */
export class NoticePreferences extends AggregateRoot {
  private constructor(
    id: Id,
    readonly ownerId: Id,
    private current: NoticeFlags,
    version: number,
  ) {
    super(id, version);
  }

  /** A person's preferences, every kind on, for one nobody has changed yet: a new aggregate under an id it generates, recording nothing. */
  static open({ ownerId }: { ownerId: Id }): NoticePreferences {
    return new NoticePreferences(Id.generate(), ownerId, { expense: true, reminder: true, budget: true }, 0);
  }

  /** The preferences as they are kept, at the version they were read at; it records nothing. */
  static fromSnapshot({
    id,
    ownerId,
    flags,
    version,
  }: {
    id: string;
    ownerId: string;
    flags: NoticeFlags;
    version: number;
  }): NoticePreferences {
    return new NoticePreferences(new Id(id), new Id(ownerId), { ...flags }, version);
  }

  /** Whether a notice of this kind is made for the person: it is, unless they turned it off. */
  enables(kind: NoticeKind): boolean {
    return this.current[kind];
  }

  /** Every kind's flag, as it is kept. */
  get flags(): NoticeFlags {
    return { ...this.current };
  }

  /**
   * Turns a kind on or off from `now`. A kind that is not one of the three is refused; a kind already at `enabled` changes nothing.
   */
  set({ kind, enabled, now }: { kind: string; enabled: boolean; now: Date }): IResult<void> {
    const checked = noticeKindOf(kind);
    if (checked.isFailure()) return Result.fail(checked.error);
    if (this.current[checked.data] === enabled) return Result.ok();

    this.current = { ...this.current, [checked.data]: enabled };
    this.record(
      NoticePreferenceChangedEvent.set({
        preferenceId: this._id.value,
        ownerId: this.ownerId.value,
        kind: checked.data,
        enabled,
        at: now.toISOString(),
      }),
    );
    return Result.ok();
  }
}
