import { AggregateRoot, Id } from '@Architecture/Domain';

import {
  DebtClearedEvent,
  DebtNotedEvent,
  ReminderIssuedEvent,
} from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';

/** A debt is noticed above this many minor units (2000 is 20.00 in the group's currency): a member who owes this much or less is not. */
export const DEBT_THRESHOLD = 2000;

/**
 * What the sweep has seen of one member's debt in one group (ADR 10): since which sweep they have owed more than the threshold
 * (`notedSince`, null when they do not owe it now), and when they were last reminded. A sweep that sees the debt gone clears
 * `notedSince` but keeps the last reminder, so a debt that comes back waits a period from the sweep that sees it. Time is a
 * parameter of each behaviour (DOMAIN-ONE-CLOCK).
 */
export class DebtWatch extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly memberId: Id,
    private since: Date | null,
    private reminded: Date | null,
    version: number,
  ) {
    super(id, version);
  }

  /** A watch for a member not seen owing yet: nothing is noted until a sweep sees the debt. It records nothing. */
  static open({ groupId, memberId }: { groupId: Id; memberId: Id }): DebtWatch {
    return new DebtWatch(Id.generate(), groupId, memberId, null, null, 0);
  }

  /** The watch as it is kept, at the version it was read at; it records nothing. */
  static fromSnapshot({
    id,
    groupId,
    memberId,
    notedSince,
    remindedAt,
    version,
  }: {
    id: string;
    groupId: string;
    memberId: string;
    notedSince: string | null;
    remindedAt: string | null;
    version: number;
  }): DebtWatch {
    return new DebtWatch(
      new Id(id),
      new Id(groupId),
      new Id(memberId),
      notedSince === null ? null : new Date(notedSince),
      remindedAt === null ? null : new Date(remindedAt),
      version,
    );
  }

  /** The sweep that first saw the debt, or null when the debt is not noted now. */
  get notedSince(): Date | null {
    return this.since;
  }

  /** The last time the member was reminded of this debt, or null when never. */
  get lastReminded(): Date | null {
    return this.reminded;
  }

  /**
   * The sweep at `now` sees the member owe `owed` in the group. Above the threshold the debt is noted, from this sweep when it was not
   * noted before; at the threshold or below it is no longer noted.
   */
  see({ owed, now }: { owed: number; now: Date }): void {
    const owing = owed > DEBT_THRESHOLD;
    if (owing && this.since === null) {
      this.since = now;
      this.record(
        DebtNotedEvent.set({
          watchId: this._id.value,
          groupId: this.groupId.value,
          memberId: this.memberId.value,
          at: now.toISOString(),
        }),
      );
    } else if (!owing && this.since !== null) {
      this.since = null;
      this.record(
        DebtClearedEvent.set({
          watchId: this._id.value,
          groupId: this.groupId.value,
          memberId: this.memberId.value,
          at: now.toISOString(),
        }),
      );
    }
  }

  /**
   * At the sweep at `now`, the member is reminded when the debt has been noted for a `period` (in milliseconds) and they were not
   * reminded during the last one. Returns whether they were reminded, with the amount they owe as the sweep last saw it.
   */
  remindIfDue({ owed, now, period }: { owed: number; now: Date; period: number }): boolean {
    if (this.since === null) return false;
    if (now.getTime() - this.since.getTime() < period) return false;
    if (this.reminded !== null && now.getTime() - this.reminded.getTime() < period) return false;

    this.reminded = now;
    this.record(
      ReminderIssuedEvent.set({
        watchId: this._id.value,
        groupId: this.groupId.value,
        memberId: this.memberId.value,
        amount: owed,
        at: now.toISOString(),
      }),
    );
    return true;
  }
}
