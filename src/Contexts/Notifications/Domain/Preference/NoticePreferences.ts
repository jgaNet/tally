import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { UnknownNoticeKind } from '@Contexts/Notifications/Domain/Preference/NoticePreferenceExceptions';
import { NoticePreferenceChangedEvent } from '@Contexts/Notifications/Domain/Preference/Events/NoticePreferenceEvents';

/** The kinds of notice, in the order a person reads them (request 36). */
export const NOTICE_KINDS: readonly NoticeKind[] = ['expense', 'reminder', 'budget'];

export function isNoticeKind(kind: string): kind is NoticeKind {
  return (NOTICE_KINDS as readonly string[]).includes(kind);
}

export interface NoticePreferencesSnapshot {
  id: string;
  memberId: string;
  expense: boolean;
  reminder: boolean;
  budget: boolean;
}

/**
 * One person's choice, kind by kind, of whether they are told (request 36, ADR 27). Every kind is on until the person turns it
 * off: a person with no preferences stored has all three on, so there is no row to make before the first change. A change
 * is made by `register()`, for the first change a person makes, or `change()`, for any later one; each records
 * NoticePreferenceChanged when the choice of the kind really moves. A notice made later reads the choice in force at that
 * moment, through `wants()`, which answers for a person with none stored as for all on.
 */
export class NoticePreferences extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly memberId: Id,
    private readonly switches: Record<NoticeKind, boolean>,
  ) {
    super(id, version);
  }

  /** The first change a person makes (`register()`, the creation rule's name for a new aggregate): the kind is set, every other kind stays on, and NoticePreferenceChanged is recorded. */
  static register({
    memberId,
    kind,
    enabled,
    at,
  }: {
    memberId: Id;
    kind: string;
    enabled: boolean;
    at: Date;
  }): IResult<NoticePreferences> {
    if (!isNoticeKind(kind)) return Result.fail(new UnknownNoticeKind());
    const id = Id.generate();
    const prefs = new NoticePreferences(id, 0, memberId, { expense: true, reminder: true, budget: true });
    prefs.switches[kind] = enabled;
    prefs.record(
      NoticePreferenceChangedEvent.set({
        preferencesId: id.value,
        memberId: memberId.value,
        kind,
        enabled,
        changedAt: at.toISOString(),
      }),
    );
    return Result.ok(prefs);
  }

  /** The preferences as they are stored. Records nothing; a stored row that does not hold together is refused by throwing. */
  static fromSnapshot(snapshot: NoticePreferencesSnapshot, version: number): NoticePreferences {
    return new NoticePreferences(new Id(snapshot.id), version, new Id(snapshot.memberId), {
      expense: snapshot.expense,
      reminder: snapshot.reminder,
      budget: snapshot.budget,
    });
  }

  /** Whether a person is told of a kind of notice, given their stored preferences, or none stored (all on). */
  static wants(preferences: NoticePreferences | null, kind: NoticeKind): boolean {
    return preferences ? preferences.isOn(kind) : true;
  }

  /** Turns a kind on or off for this person; records NoticePreferenceChanged only when the choice of the kind moves. */
  change({ kind, enabled, at }: { kind: string; enabled: boolean; at: Date }): IResult<void> {
    if (!isNoticeKind(kind)) return Result.fail(new UnknownNoticeKind());
    if (this.switches[kind] === enabled) return Result.ok();
    this.switches[kind] = enabled;
    this.record(
      NoticePreferenceChangedEvent.set({
        preferencesId: this._id.value,
        memberId: this.memberId.value,
        kind,
        enabled,
        changedAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  isOn(kind: NoticeKind): boolean {
    return this.switches[kind];
  }

  toSnapshot(): NoticePreferencesSnapshot {
    return {
      id: this._id.value,
      memberId: this.memberId.value,
      expense: this.switches.expense,
      reminder: this.switches.reminder,
      budget: this.switches.budget,
    };
  }
}
