import { AggregateRoot, DomainEvent, Id } from '@Architecture/Domain';
import { minorUnitsOf } from '@SharedKernel/Domain';

/**
 * A debt is reminded of only above this much still owed, in the group's currency's minor unit: more than 20 of it (request 18, request 40).
 * That is 2000 hundredths of euros, 20 yen, 20 000 thousandths of dinars.
 */
export const reminderThresholdOf = (currency: string): number => minorUnitsOf(currency, 20);

/** What a sweep's sighting of a member's debt decides: whether a reminder is due now, and whether the watch changed at all. */
export interface Sighting {
  readonly reminderDue: boolean;
  readonly changed: boolean;
}

export interface DebtWatchDraft {
  readonly groupId: string;
  readonly memberId: string;
}

/** A watch as the store keeps it: the member and group, since which run it has seen them owe more than the threshold, and the last reminder. */
export interface DebtWatchSnapshot extends DebtWatchDraft {
  readonly id: string;
  readonly notedAt?: string;
  readonly lastReminderAt?: string;
  readonly version: number;
}

/**
 * What the sweep keeps of one member's debt in one group (the storm's DebtWatch, conventions/domain.yaml): since when it has been seen
 * above the threshold (`notedAt`, the run that saw it), and when the member was last reminded (kept even after the debt is cleared, so
 * a debt that comes back waits a period from the run that sees it). It is an aggregate root because it records what happened to the
 * watch: DebtNoted, DebtCleared, ReminderIssued. Only the sweep changes it, and it is loaded at a version and saved over that version
 * (CONC-OPTIMISTIC): of two servers sweeping one database, the one that loses reads the reminder the other made and decides again.
 */
export class DebtWatch extends AggregateRoot {
  readonly #groupId: string;
  readonly #memberId: string;
  #notedAt: string | undefined;
  #lastReminderAt: string | undefined;
  #changed = false;

  private constructor(
    id: Id,
    version: number,
    groupId: string,
    memberId: string,
    notedAt?: string,
    lastReminderAt?: string,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#memberId = memberId;
    this.#notedAt = notedAt;
    this.#lastReminderAt = lastReminderAt;
  }

  /** A watch for a member not seen owing before: nothing noted, nothing reminded. Its identity is generated here (DOMAIN-IDENTITY). */
  static create({ groupId, memberId }: DebtWatchDraft): DebtWatch {
    return new DebtWatch(Id.generate(), 0, groupId, memberId);
  }

  /** The watch as the store keeps it. Records nothing. */
  static fromSnapshot(snapshot: DebtWatchSnapshot): DebtWatch {
    return new DebtWatch(
      new Id(snapshot.id),
      snapshot.version,
      snapshot.groupId,
      snapshot.memberId,
      snapshot.notedAt,
      snapshot.lastReminderAt,
    );
  }

  get groupId(): string {
    return this.#groupId;
  }

  get memberId(): string {
    return this.#memberId;
  }

  /** Whether this sweep changed the watch: the store saves it, and its facts are published, only then. */
  get changed(): boolean {
    return this.#changed;
  }

  /**
   * The sweep saw the member owe `owes` at `now`. Above the threshold, the debt is noted from this run if it was not already, and a
   * reminder is due when the debt has been noted for a period or more and the member was not reminded during the last period. At or
   * below it, the watch is cleared. Pure: the threshold, the time and the period are given.
   */
  sight(owes: number, threshold: number, now: Date, periodMs: number): Sighting {
    if (owes <= threshold) {
      this.#clear(now);
      return { reminderDue: false, changed: this.#changed };
    }
    if (this.#notedAt === undefined) {
      this.#notedAt = now.toISOString();
      this.#changed = true;
      this.record(
        DebtNotedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, owes, at: now.toISOString() }),
      );
    }
    const lasted = now.getTime() - new Date(this.#notedAt).getTime() >= periodMs;
    const reminded =
      this.#lastReminderAt !== undefined && now.getTime() - new Date(this.#lastReminderAt).getTime() < periodMs;
    return { reminderDue: lasted && !reminded, changed: this.#changed };
  }

  /** Reminds the member now: the last reminder is kept, and ReminderIssued is recorded with the notice it makes. */
  remind(owes: number, now: Date): void {
    this.#lastReminderAt = now.toISOString();
    this.#changed = true;
    this.record(
      ReminderIssuedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, owes, at: now.toISOString() }),
    );
  }

  /** The sweep no longer sees the member owing above the threshold (or no longer sees them as a member): the watch is cleared. */
  clear(now: Date): void {
    this.#clear(now);
  }

  #clear(now: Date): void {
    if (this.#notedAt === undefined) return;
    this.#notedAt = undefined;
    this.#changed = true;
    this.record(DebtClearedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, at: now.toISOString() }));
  }

  toSnapshot(): DebtWatchSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      memberId: this.#memberId,
      ...(this.#notedAt !== undefined && { notedAt: this.#notedAt }),
      ...(this.#lastReminderAt !== undefined && { lastReminderAt: this.#lastReminderAt }),
      version: this.version,
    };
  }
}

export type DebtNotedPayload = { groupId: string; memberId: string; owes: number; at: string };
export type DebtClearedPayload = { groupId: string; memberId: string; at: string };
export type ReminderIssuedPayload = { groupId: string; memberId: string; owes: number; at: string };

/** A member was seen owing above the threshold, and is noted from this run. */
export class DebtNotedEvent extends DomainEvent<DebtNotedPayload> {}
/** A member was seen at or below the threshold, or is no longer in the group: the watch is cleared. */
export class DebtClearedEvent extends DomainEvent<DebtClearedPayload> {}
/** A member was reminded of a debt that lasted. */
export class ReminderIssuedEvent extends DomainEvent<ReminderIssuedPayload> {}
