import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { NothingToNetException } from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

export type NettingRecordedPayload = {
  nettingId: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlementIds: string[];
  at: string;
};

/** Two members netted what they owe each other across their groups, as settlements that count at once (request 32). */
export class NettingRecordedEvent extends DomainEvent<NettingRecordedPayload> {}

/** What a netting is made of once its settlements are decided: who asked, with whom, the currency, the amount, and the settlements' ids. */
export interface NettingDraft {
  readonly by: string;
  readonly with: string;
  readonly currency: string;
  readonly amount: number;
  readonly settlementIds: readonly string[];
  readonly at: Date;
}

/**
 * A netting between two members (feature 32, request 32, conventions/domain.yaml, the storm's `Netting`): the settlements made across
 * the groups they share, netted in one currency. It keeps who asked, with whom, the currency, the amount netted and its settlements, in
 * the order they were made; the two people read it, and nobody else does. Its identity is generated when it is made, and it is made
 * only with the settlements it answers, in the same transaction (ADR 27). It is never changed.
 */
export class Netting extends AggregateRoot {
  readonly #by: string;
  readonly #with: string;
  readonly #currency: string;
  readonly #amount: number;
  readonly #settlementIds: readonly string[];
  readonly #at: string;

  private constructor(
    id: Id,
    by: string,
    withId: string,
    currency: string,
    amount: number,
    settlementIds: readonly string[],
    at: string,
  ) {
    super(id, 0);
    this.#by = by;
    this.#with = withId;
    this.#currency = currency;
    this.#amount = amount;
    this.#settlementIds = settlementIds;
    this.#at = at;
  }

  /**
   * Makes a netting of at least 1 and of at least two settlements (one each way, since a netting moves money both ways), and records
   * NettingRecorded. Refused, and nothing made, otherwise. The time is `at`.
   */
  static make(draft: NettingDraft): IResult<Netting> {
    if (!Number.isInteger(draft.amount) || draft.amount < 1 || draft.settlementIds.length < 2) {
      return Result.fail(new NothingToNetException());
    }
    const netting = new Netting(
      Id.generate(),
      draft.by,
      draft.with,
      draft.currency,
      draft.amount,
      [...draft.settlementIds],
      draft.at.toISOString(),
    );
    netting.record(
      NettingRecordedEvent.set({
        nettingId: netting._id.value,
        by: draft.by,
        with: draft.with,
        currency: draft.currency,
        amount: draft.amount,
        settlementIds: [...draft.settlementIds],
        at: netting.#at,
      }),
    );
    return Result.ok(netting);
  }

  /** The netting's identity, the id its creation answered. */
  get id(): string {
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

  /** When the netting was made, as an ISO 8601 instant. */
  get at(): string {
    return this.#at;
  }

  /** The settlements the netting made, in the order they were made. */
  get settlementIds(): readonly string[] {
    return this.#settlementIds;
  }
}
