import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { decimalsOf } from '@SharedKernel/Domain/Currency';

import { IDebtWatchSnapshot } from '@Contexts/Notifications/Domain/DebtWatch/DTOs';
import {
  DebtClearedEvent,
  DebtNotedEvent,
  ReminderIssuedEvent,
} from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';
import { InvalidDebtWatchException } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatchExceptions';

/**
 * A debt lasts, and is reminded, once it is more than 20 of its group's currency (request 18, request 40): 2000 hundredths in
 * EUR, 20 yen in JPY, 20 000 thousandths in KWD. The amount is in the currency's minor unit.
 */
export function lingeringDebtOver(currency: string): number {
  return 20 * 10 ** decimalsOf(currency);
}

/**
 * DebtWatch is the aggregate of one member's debt in one group, as the background job keeps it (request 18, the storm
 * `reminders`). It holds two facts the rule needs: since which run the member has been seen owing more than 2000 (`notedSince`),
 * and when they were last reminded. A run that sees 2000 or less clears the note; the last reminder is kept, so a debt that
 * comes back waits a period from the run that sees it. Nothing here reads the time: each run hands its instant and its period.
 */
export class DebtWatch extends AggregateRoot {
  readonly #groupId: string;
  readonly #memberId: string;
  #notedSince: Date | null;
  #lastReminded: Date | null;

  private constructor(
    id: Id,
    groupId: string,
    memberId: string,
    notedSince: Date | null,
    lastReminded: Date | null,
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#memberId = memberId;
    this.#notedSince = notedSince;
    this.#lastReminded = lastReminded;
  }

  /** A watch for a member of a group that has none yet: its id is generated here; it records nothing until a run sees a debt. */
  static open({ groupId, memberId }: { groupId: string; memberId: string }): IResult<DebtWatch> {
    if (!groupId || !memberId) return Result.fail(new InvalidDebtWatchException('A debt is a member of a group'));
    return Result.ok(new DebtWatch(Id.generate(), groupId, memberId, null, null, 0));
  }

  /** The watch as the store holds it. Records nothing; throws on a watch no rule could have made. */
  static fromSnapshot({ _id, groupId, memberId, notedSince, lastReminded, version }: IDebtWatchSnapshot): DebtWatch {
    if (!groupId || !memberId || (notedSince !== null && isNaN(notedSince.getTime()))) {
      throw new Error(`Corrupted debt watch ${_id}`);
    }
    return new DebtWatch(new Id(_id), groupId, memberId, notedSince, lastReminded, version);
  }

  /**
   * What the run at `at` decides about this member, who owes `owes` now, against `over`: the amount above which a debt lasts, which
   * the job reads from the group's currency (`lingeringDebtOver`, request 40), and 0 for a member who owes nothing. Owing more than `over` notes the
   * debt from this run, if it was not noted; a debt noted for `periodMs` or more, not reminded in the last `periodMs`, is reminded
   * at this run. Owing 2000 or less clears the note. Returns whether anything changed (so the caller saves) and whether a reminder
   * is owed (so the caller makes the notice); the events are recorded here.
   *
   * `mayRemind` is whether the member wants reminders now (request 36). A reminder they have turned off is not owed and not
   * recorded: the debt stays noted, and the first run after they turn reminders on again reminds it, as if none was missed.
   */
  observe({
    over,
    owes,
    at,
    periodMs,
    mayRemind,
  }: {
    over: number;
    owes: number;
    at: Date;
    periodMs: number;
    mayRemind: boolean;
  }): {
    changed: boolean;
    reminded: boolean;
  } {
    if (owes <= over) {
      if (!this.#notedSince) return { changed: false, reminded: false };
      this.#notedSince = null;
      this.record(DebtClearedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, at: at.toISOString() }));
      return { changed: true, reminded: false };
    }

    let changed = false;
    if (!this.#notedSince) {
      this.#notedSince = at;
      this.record(DebtNotedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, at: at.toISOString() }));
      changed = true;
    }

    const lingered = at.getTime() - this.#notedSince.getTime() >= periodMs;
    const notRemindedLately = !this.#lastReminded || at.getTime() - this.#lastReminded.getTime() >= periodMs;
    if (!lingered || !notRemindedLately || !mayRemind) return { changed, reminded: false };

    this.#lastReminded = at;
    this.record(
      ReminderIssuedEvent.set({
        groupId: this.#groupId,
        memberId: this.#memberId,
        owes,
        at: at.toISOString(),
      }),
    );
    return { changed: true, reminded: true };
  }

  get groupId(): string {
    return this.#groupId;
  }

  get memberId(): string {
    return this.#memberId;
  }

  toSnapshot(): IDebtWatchSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      memberId: this.#memberId,
      notedSince: this.#notedSince ? new Date(this.#notedSince) : null,
      lastReminded: this.#lastReminded ? new Date(this.#lastReminded) : null,
      version: this.version,
    };
  }
}
