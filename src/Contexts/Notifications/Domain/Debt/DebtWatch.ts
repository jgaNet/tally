import { AggregateRoot, Id } from '@Architecture/Domain';

import {
  DebtClearedEvent,
  DebtNotedEvent,
  ReminderIssuedEvent,
} from '@Contexts/Notifications/Domain/Debt/Events/DebtEvents';

/**
 * The debts a member is reminded of are over this amount, in the group's currency's minor units (20.00 is 2000), so a debt of exactly
 * 2000 is not one (request 18).
 */
export const REMINDED_ABOVE = 2000;

/** What the sweep did to a watch in one run: nothing, a debt noted, cleared, or a reminder issued (docs/adr/0018). */
export type SweepOutcome = 'none' | 'noted' | 'cleared' | 'reminded';

/**
 * The sweep's memory of one member's debt in one group (request 18, docs/adr/0018): since which run the member has been seen to owe more
 * than 2000 (`notedSince`), and when it was last reminded (`lastRemindedAt`). A debt that comes back is noted from the run that sees it,
 * and the last reminder is kept, so a member is reminded at most once a period.
 *
 * `open()` generates the id; it records nothing, since the first fact is the debt being noted (`sweep()`). `sweep()` is a pure step of
 * the state, the amount owed and the time the sweep runs at: the time is a parameter, and the period is too.
 */
export class DebtWatch extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly accountId: string,
    readonly groupId: string,
    private _notedSince: Date | undefined,
    private _lastRemindedAt: Date | undefined,
  ) {
    super(id, version);
  }

  static open({ accountId, groupId }: { accountId: string; groupId: string }): DebtWatch {
    return new DebtWatch(Id.generate(), 0, accountId, groupId, undefined, undefined);
  }

  static fromSnapshot(snapshot: {
    id: string;
    version: number;
    accountId: string;
    groupId: string;
    notedSince?: string;
    lastRemindedAt?: string;
  }): DebtWatch {
    if (!snapshot.id || !snapshot.accountId || !snapshot.groupId || !Number.isInteger(snapshot.version)) {
      throw new Error(`The debt watch ${snapshot.id} is corrupted in the store`);
    }
    return new DebtWatch(
      new Id(snapshot.id),
      snapshot.version,
      snapshot.accountId,
      snapshot.groupId,
      snapshot.notedSince === undefined ? undefined : new Date(snapshot.notedSince),
      snapshot.lastRemindedAt === undefined ? undefined : new Date(snapshot.lastRemindedAt),
    );
  }

  get notedSince(): Date | undefined {
    return this._notedSince;
  }

  get lastRemindedAt(): Date | undefined {
    return this._lastRemindedAt;
  }

  /**
   * One run of the sweep for this member and group, which owes `owed` now (0 when it owes nothing):
   *  - more than 2000 and not noted: noted from `now` (DebtNoted);
   *  - more than 2000, noted for a period or more, and not reminded in the last period: reminded (ReminderIssued);
   *  - 2000 or less and noted: no longer noted (DebtCleared).
   * Anything else changes nothing, and answers `none`.
   */
  sweep(owed: number, now: Date, periodMs: number): SweepOutcome {
    if (owed > REMINDED_ABOVE) {
      if (this._notedSince === undefined) {
        this._notedSince = now;
        this.record(DebtNotedEvent.set({ accountId: this.accountId, groupId: this.groupId, amount: owed }));
        return 'noted';
      }
      const lastedAPeriod = now.getTime() - this._notedSince.getTime() >= periodMs;
      const notRemindedThisPeriod =
        this._lastRemindedAt === undefined || now.getTime() - this._lastRemindedAt.getTime() >= periodMs;
      if (lastedAPeriod && notRemindedThisPeriod) {
        this._lastRemindedAt = now;
        this.record(ReminderIssuedEvent.set({ accountId: this.accountId, groupId: this.groupId, amount: owed }));
        return 'reminded';
      }
      return 'none';
    }
    if (this._notedSince !== undefined) {
      this._notedSince = undefined;
      this.record(DebtClearedEvent.set({ accountId: this.accountId, groupId: this.groupId }));
      return 'cleared';
    }
    return 'none';
  }

  toSnapshot(): {
    id: string;
    accountId: string;
    groupId: string;
    notedSince?: string;
    lastRemindedAt?: string;
  } {
    return {
      id: this._id.value,
      accountId: this.accountId,
      groupId: this.groupId,
      ...(this._notedSince === undefined ? {} : { notedSince: this._notedSince.toISOString() }),
      ...(this._lastRemindedAt === undefined ? {} : { lastRemindedAt: this._lastRemindedAt.toISOString() }),
    };
  }
}
