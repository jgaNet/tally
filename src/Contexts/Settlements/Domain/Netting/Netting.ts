import { AggregateRoot, Id } from '@Architecture/Domain';

import { NettingRecordedEvent } from './NettingEvents';

/** What a netting is made of, once its settlements are recorded: who asked, with whom, the currency, the amount, and the settlements' ids. */
export interface NettingValues {
  by: string;
  with: string;
  currency: string;
  amount: number;
  /** The settlements the netting made, in the order they were made. */
  settlements: string[];
}

/**
 * A netting of two members (request 32, ADR 30): what they owe each other across their groups, netted in one currency, as the settlements
 * of each group. It is made once and never changed, so it is created and never loaded: the read side answers it (`GetNetting`). Its own
 * identity is generated here (DOMAIN-IDENTITY), and it is saved in the same transaction as the settlements it made, so a netting is all or
 * nothing. The rules of a netting are the decision's (`Netting.decision.ts`); this records it.
 */
export class Netting extends AggregateRoot {
  readonly #by: string;
  readonly #with: string;
  readonly #currency: string;
  readonly #amount: number;
  readonly #settlements: readonly string[];

  private constructor(
    id: Id,
    by: string,
    withMember: string,
    currency: string,
    amount: number,
    settlements: readonly string[],
  ) {
    super(id, 0);
    this.#by = by;
    this.#with = withMember;
    this.#currency = currency;
    this.#amount = amount;
    this.#settlements = settlements;
  }

  /**
   * A netting made of the settlements its decision allowed: its id generated here, recording that it was made (DOMAIN-CREATE-VS-RECONSTITUTE,
   * `register`). Throws on values no decision allows (an amount below 1, fewer than two settlements), which is a programming error and not a
   * refusal.
   */
  static register({ by, with: withMember, currency, amount, settlements }: NettingValues): Netting {
    if (!Number.isInteger(amount) || amount < 1) throw new Error('A netting nets an amount of at least 1');
    if (settlements.length < 2) throw new Error('A netting makes at least two settlements, one each way');
    const netting = new Netting(Id.generate(), by, withMember, currency, amount, [...settlements]);
    netting.record(
      NettingRecordedEvent.set({
        nettingId: netting.nettingId,
        by,
        with: withMember,
        currency,
        amount,
        settlementIds: [...settlements],
      }),
    );
    return netting;
  }

  get nettingId(): string {
    return this._id.value;
  }

  get by(): string {
    return this.#by;
  }

  get with(): string {
    return this.#with;
  }

  get currency(): string {
    return this.#currency;
  }

  get amount(): number {
    return this.#amount;
  }

  get settlements(): readonly string[] {
    return this.#settlements;
  }
}
