import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import {
  DebtClearedEvent,
  DebtNotedEvent,
  ReminderIssuedEvent,
} from '@Contexts/Notifications/Domain/Debt/Events/DebtEvents';
import { DebtNotOverThreshold } from '@Contexts/Notifications/Domain/Debt/DebtExceptions';

/** What one run of the sweep did to a member's watch: nothing, a change of its noting, or a reminder to make now. */
export type WatchStep = 'unchanged' | 'changed' | 'reminded';

export interface DebtWatchSnapshot {
  id: string;
  groupId: string;
  memberId: string;
  notedSince: string | null;
  lastReminded: string | null;
}

/**
 * The sweep's record of one member's debt in one group (ADR 12): since which run it has been seen over the threshold, and
 * when the member was last reminded. A run that sees the debt at or under the threshold clears the noting, and keeps the
 * last reminder, so a debt that comes back is noted again from the run that sees it, and waits a period from there. A
 * reminder is made when the debt has been noted for a period and no reminder was made in the last one; the period is
 * given by the wiring, and the time by the job, never read here.
 */
export class DebtWatch extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly groupId: Id,
    readonly memberId: Id,
    private notedSince: Date | null,
    private lastReminded: Date | null,
  ) {
    super(id, version);
  }

  /**
   * A member seen over the threshold (`threshold`, the group's currency's, request 40) for the first time: noted from this run, and
   * DebtNoted recorded.
   */
  static create({
    groupId,
    memberId,
    owed,
    at,
    threshold,
  }: {
    groupId: Id;
    memberId: Id;
    owed: number;
    at: Date;
    threshold: number;
  }): IResult<DebtWatch> {
    if (owed <= threshold) return Result.fail(new DebtNotOverThreshold());
    const id = Id.generate();
    const watch = new DebtWatch(id, 0, groupId, memberId, at, null);
    watch.record(
      DebtNotedEvent.set({
        watchId: id.value,
        groupId: groupId.value,
        memberId: memberId.value,
        owed,
        notedAt: at.toISOString(),
      }),
    );
    return Result.ok(watch);
  }

  /** The watch as it is stored. Records nothing; a stored watch that does not hold together is refused by throwing. */
  static fromSnapshot(snapshot: DebtWatchSnapshot, version: number): DebtWatch {
    const notedSince = parseInstant(snapshot.notedSince);
    const lastReminded = parseInstant(snapshot.lastReminded);
    if (snapshot.notedSince !== null && notedSince === null)
      throw new Error('A stored debt watch has a bad noting time');
    if (snapshot.lastReminded !== null && lastReminded === null)
      throw new Error('A stored debt watch has a bad reminder time');
    return new DebtWatch(
      new Id(snapshot.id),
      version,
      new Id(snapshot.groupId),
      new Id(snapshot.memberId),
      notedSince,
      lastReminded,
    );
  }

  /**
   * One run of the sweep sees what the member owes now. Returns what the run did: `reminded` when a reminder is due (the
   * caller makes the notice in the same transaction), `changed` when the noting moved, `unchanged` otherwise. A reminder that is
   * due but not wanted (`remind` false: the member turned reminders off) is not made, and counts as made by no one, so it is
   * still due at the first run that finds reminders on.
   */
  observe({
    owed,
    at,
    period,
    remind,
    threshold,
  }: {
    owed: number;
    at: Date;
    period: number;
    remind: boolean;
    threshold: number;
  }): WatchStep {
    if (owed <= threshold) {
      if (this.notedSince === null) return 'unchanged';
      this.notedSince = null;
      this.record(
        DebtClearedEvent.set({
          watchId: this._id.value,
          groupId: this.groupId.value,
          memberId: this.memberId.value,
          clearedAt: at.toISOString(),
        }),
      );
      return 'changed';
    }
    if (this.notedSince === null) {
      this.notedSince = at;
      this.record(
        DebtNotedEvent.set({
          watchId: this._id.value,
          groupId: this.groupId.value,
          memberId: this.memberId.value,
          owed,
          notedAt: at.toISOString(),
        }),
      );
      return 'changed';
    }
    const lasted = at.getTime() - this.notedSince.getTime() >= period;
    const quiet = this.lastReminded === null || at.getTime() - this.lastReminded.getTime() >= period;
    if (!lasted || !quiet || !remind) return 'unchanged';
    this.lastReminded = at;
    this.record(
      ReminderIssuedEvent.set({
        watchId: this._id.value,
        groupId: this.groupId.value,
        memberId: this.memberId.value,
        owed,
        at: at.toISOString(),
      }),
    );
    return 'reminded';
  }

  toSnapshot(): DebtWatchSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      memberId: this.memberId.value,
      notedSince: this.notedSince?.toISOString() ?? null,
      lastReminded: this.lastReminded?.toISOString() ?? null,
    };
  }
}

function parseInstant(text: string | null): Date | null {
  if (text === null) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}
