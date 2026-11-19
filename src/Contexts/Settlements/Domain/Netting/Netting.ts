import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { NettingRecordedEvent } from '@Contexts/Settlements/Domain/Netting/Events/NettingEvents';
import { NettingWithOneself, NothingToNet } from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

/**
 * A netting (request 32, ADR 23): what two members owe each other across their groups, netted in one currency, as the
 * settlements that made it. It keeps who asked, with whom, the currency, the amount and the settlements' ids, in the order
 * they were made. It is written once, in the transaction of the settlements it made, and never changed; the settlements
 * themselves are the SettlementBooks' (NetDebts decides them).
 */
export class Netting extends AggregateRoot {
  private constructor(
    id: Id,
    readonly by: Id,
    readonly other: Id,
    readonly currency: string,
    readonly amount: number,
    readonly settlements: readonly Id[],
    readonly at: Date,
  ) {
    super(id, 0);
  }

  /**
   * A netting made now, with a generated id, and NettingRecorded. The name is `make`, not `create`: PayoutAccount's create() is
   * another aggregate's behaviour in this context, and the storm reads a handler's `create(` by name (as Invitation's `issue`).
   * Refused when it is with oneself or when it nets nothing.
   */
  static make({
    by,
    with: other,
    currency,
    amount,
    settlements,
    at,
  }: {
    by: Id;
    with: Id;
    currency: string;
    amount: number;
    settlements: readonly Id[];
    at: Date;
  }): IResult<Netting> {
    if (by.equals(other)) return Result.fail(new NettingWithOneself());
    if (!Number.isInteger(amount) || amount < 1 || settlements.length < 2) return Result.fail(new NothingToNet());

    const netting = new Netting(Id.generate(), by, other, currency, amount, [...settlements], at);
    netting.record(
      NettingRecordedEvent.set({
        nettingId: netting._id.value,
        by: by.value,
        with: other.value,
        currency,
        amount,
        settlementIds: netting.settlements.map(settlement => settlement.value),
        nettedAt: at.toISOString(),
      }),
    );
    return Result.ok(netting);
  }
}
