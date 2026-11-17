import { AggregateRoot, Id } from '@Architecture/Domain';

import { DebtClearedEvent, DebtNotedEvent, ReminderIssuedEvent } from './DebtWatchEvents';

/** A debt watch as it is stored, at the version it was read at. */
export interface DebtWatchSnapshot {
  id: string;
  groupId: string;
  memberId: string;
  notedSince: string | null;
  remindedAt: string | null;
  version: number;
}

/**
 * What the background job has seen of one member in one group (request 18, ADR 15): since which run they owe more than the
 * threshold, and when they were last reminded. Two servers sweep the same database, so two writers can reach it: it carries the
 * version it was read at (CONC-OPTIMISTIC) and its store refuses a save over a newer one, which is how a member is reminded once a
 * period whatever the servers. The rules are the decision's (`DebtWatch.decision.ts`); this records what the decision decided.
 */
export class DebtWatch extends AggregateRoot {
  readonly #groupId: string;
  readonly #memberId: string;
  #notedSince: string | null;
  #remindedAt: string | null;

  private constructor(
    id: Id,
    version: number,
    groupId: string,
    memberId: string,
    notedSince: string | null,
    remindedAt: string | null,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#memberId = memberId;
    this.#notedSince = notedSince;
    this.#remindedAt = remindedAt;
  }

  /** A member first seen owing more than the threshold in a group, noted from `at`; its id is generated here, and it records `DebtNoted`. */
  static create({ groupId, memberId, at }: { groupId: string; memberId: string; at: Date }): DebtWatch {
    const when = at.toISOString();
    const watch = new DebtWatch(Id.generate(), 0, groupId, memberId, when, null);
    watch.record(DebtNotedEvent.set({ groupId, memberId, at: when }));
    return watch;
  }

  /** Rebuilds the watch as it is stored. Records nothing; throws on a version no save could store. */
  static fromSnapshot({ id, groupId, memberId, notedSince, remindedAt, version }: DebtWatchSnapshot): DebtWatch {
    if (!Number.isInteger(version) || version < 1) throw new Error(`The stored debt watch ${id} is corrupted`);
    return new DebtWatch(new Id(id), version, groupId, memberId, notedSince, remindedAt);
  }

  get groupId(): string {
    return this.#groupId;
  }

  get memberId(): string {
    return this.#memberId;
  }

  get state(): { notedSince: string | null; remindedAt: string | null } {
    return { notedSince: this.#notedSince, remindedAt: this.#remindedAt };
  }

  /** A debt that had been cleared is seen again: noted from `at`. */
  note(at: Date): void {
    this.#notedSince = at.toISOString();
    this.record(DebtNotedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, at: this.#notedSince }));
  }

  /** The debt is no longer noted; the last reminder is kept. */
  clear(at: Date): void {
    this.#notedSince = null;
    this.record(DebtClearedEvent.set({ groupId: this.#groupId, memberId: this.#memberId, at: at.toISOString() }));
  }

  /** The member is reminded at `at` of what they owe, with the notice `noticeId`. */
  remind({ noticeId, owed, at }: { noticeId: string; owed: number; at: Date }): void {
    this.#remindedAt = at.toISOString();
    this.record(
      ReminderIssuedEvent.set({
        groupId: this.#groupId,
        memberId: this.#memberId,
        noticeId,
        owed,
        at: this.#remindedAt,
      }),
    );
  }

  toSnapshot(): DebtWatchSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      memberId: this.#memberId,
      notedSince: this.#notedSince,
      remindedAt: this.#remindedAt,
      version: this.version,
    };
  }
}
