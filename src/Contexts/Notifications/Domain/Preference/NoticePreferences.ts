import { AggregateRoot, Id } from '@Architecture/Domain';

import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { NoticePreferenceSnapshot } from '@Contexts/Notifications/Domain/Preference/DTOs';
import { NoticePreferenceChangedEvent } from '@Contexts/Notifications/Domain/Preference/Events/NoticePreferenceEvents';

/**
 * What a person receives, kind by kind (request 36, docs/adr/0036): every kind is on until they turn it off, and on again when they turn it
 * on. A notice of a kind that is off is not made for them, from then on; what was made before does not change, and nothing missed while
 * it was off is made later (a reminder that was not made is the one exception, which the DebtWatch keeps: docs/adr/0018).
 *
 * `open()` generates the id and answers every kind on; it records nothing. `set()` records NoticePreferenceChanged when a kind changes, and
 * answers whether it did. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data.
 */
export class NoticePreferences extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly accountId: string,
    private readonly on: Record<NoticeKind, boolean>,
  ) {
    super(id, version);
  }

  static open({ accountId }: { accountId: string }): NoticePreferences {
    return new NoticePreferences(Id.generate(), 0, accountId, { expense: true, reminder: true, budget: true });
  }

  static fromSnapshot(snapshot: NoticePreferenceSnapshot): NoticePreferences {
    const flags = [snapshot.expense, snapshot.reminder, snapshot.budget];
    if (
      !snapshot.id ||
      !snapshot.accountId ||
      !Number.isInteger(snapshot.version) ||
      flags.some(f => typeof f !== 'boolean')
    ) {
      throw new Error(`The notice preferences ${snapshot.id} are corrupted in the store`);
    }
    return new NoticePreferences(new Id(snapshot.id), snapshot.version, snapshot.accountId, {
      expense: snapshot.expense,
      reminder: snapshot.reminder,
      budget: snapshot.budget,
    });
  }

  /** Whether the person receives a notice of this kind now. */
  isOn(kind: NoticeKind): boolean {
    return this.on[kind];
  }

  /** Turns a kind on or off. Answers `true` when it changed the kind (and recorded NoticePreferenceChanged), `false` when it was already so. */
  set(kind: NoticeKind, enabled: boolean): boolean {
    if (this.on[kind] === enabled) return false;
    this.on[kind] = enabled;
    this.record(NoticePreferenceChangedEvent.set({ accountId: this.accountId, kind, enabled }));
    return true;
  }

  toSnapshot(): NoticePreferenceSnapshot {
    return {
      id: this._id.value,
      version: this.version,
      accountId: this.accountId,
      expense: this.on.expense,
      reminder: this.on.reminder,
      budget: this.on.budget,
    };
  }
}
