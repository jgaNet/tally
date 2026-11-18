import { AggregateRoot, Id } from '@Architecture/Domain';

import { NettingRecordedEvent } from '@Contexts/Settlements/Domain/Netting/Events/NettingEvents';

/** The netting as the store keeps it: its identity, who asked, with whom, the currency, the amount and its settlements' ids in order. */
export interface INettingSnapshot {
  _id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}

/**
 * Netting is what two people netted across their groups (request 32): a small aggregate, created once, that keeps who asked, with
 * whom, the currency, the amount netted and the ids of the settlements the netting made, in the order they were made. The
 * settlements themselves are the books' (each group's), decided by `NetDebts`; this records that they were made together, and
 * `NettingRecorded` says so. It is never changed after it is created, so it carries no version.
 */
export class Netting extends AggregateRoot {
  readonly #by: string;
  readonly #with: string;
  readonly #currency: string;
  readonly #amount: number;
  readonly #settlements: string[];

  private constructor(id: Id, by: string, withMember: string, currency: string, amount: number, settlements: string[]) {
    super(id);
    this.#by = by;
    this.#with = withMember;
    this.#currency = currency;
    this.#amount = amount;
    this.#settlements = settlements;
  }

  /** A netting made of these settlements: its identity generated here (DOMAIN-IDENTITY), and `NettingRecorded` recorded. */
  static create({
    by,
    with: withMember,
    currency,
    amount,
    settlements,
  }: {
    by: string;
    with: string;
    currency: string;
    amount: number;
    settlements: string[];
  }): Netting {
    const netting = new Netting(Id.generate(), by, withMember, currency, amount, [...settlements]);
    netting.record(
      NettingRecordedEvent.set({
        nettingId: netting._id.value,
        by,
        with: withMember,
        currency,
        amount,
        settlementIds: [...settlements],
      }),
    );
    return netting;
  }

  /** The netting as the store writes it, once. */
  toSnapshot(): INettingSnapshot {
    return {
      _id: this._id.value,
      by: this.#by,
      with: this.#with,
      currency: this.#currency,
      amount: this.#amount,
      settlements: [...this.#settlements],
    };
  }
}
