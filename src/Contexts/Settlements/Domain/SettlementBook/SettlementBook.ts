import { AggregateRoot, Id } from '@Architecture/Domain';

import { SettlementRecordedEvent } from './SettlementEvents';

/** A settlement as it is stored: a cash payment from one member of a group to another, recorded at `at`, paid. */
export interface SettlementSnapshot {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  at: string;
}

/**
 * The one place every settlement of a group is decided in (ADR 11, the storm's SettlementBook): an aggregate per group, which
 * carries the version it was read at (CONC-OPTIMISTIC). Two settlements of one group decided at once both read the book at one
 * version; the store saves the first and refuses the second, which reads again and is decided on the balances with the first
 * one counted. Its own identity is generated here, once, when the book is first opened for its group.
 *
 * `recordCash` is the only way a settlement enters the book: it generates the settlement's id and records `SettlementRecorded`.
 * The settlements recorded since the book was read are what the store writes, with the version, in the same transaction.
 */
export class SettlementBook extends AggregateRoot {
  readonly #groupId: string;
  #recorded: SettlementSnapshot[] = [];

  private constructor(id: Id, version: number, groupId: string) {
    super(id, version);
    this.#groupId = groupId;
  }

  /** The book of a group with no settlement stored yet: version 0, its id generated here. */
  static open(groupId: string): SettlementBook {
    return new SettlementBook(Id.generate(), 0, groupId);
  }

  /** Rebuilds the book as it is stored, at the version it was stored at. Records nothing; throws on a version no save could store. */
  static fromSnapshot({ id, groupId, version }: { id: string; groupId: string; version: number }): SettlementBook {
    if (!Number.isInteger(version) || version < 1) throw new Error(`The stored settlement book ${id} is corrupted`);
    return new SettlementBook(new Id(id), version, groupId);
  }

  get bookId(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  recorded(): readonly SettlementSnapshot[] {
    return this.#recorded;
  }

  /**
   * Records a settlement paid in cash by `from` to `to`, at `at`, whose values the decision has allowed. Generates the
   * settlement's id and records `SettlementRecorded`, published once the book is saved. Answers the new settlement's id.
   */
  recordCash({ from, to, amount, at }: { from: string; to: string; amount: number; at: Date }): string {
    const id = Id.generate().value;
    this.#recorded = [
      ...this.#recorded,
      { id, groupId: this.#groupId, from, to, amount, method: 'cash', status: 'paid', at: at.toISOString() },
    ];
    this.record(
      SettlementRecordedEvent.set({ settlementId: id, groupId: this.#groupId, payer: from, payee: to, amount }),
    );
    return id;
  }
}
