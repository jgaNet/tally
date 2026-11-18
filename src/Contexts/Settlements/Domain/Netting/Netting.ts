import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { CURRENCIES } from '@SharedKernel/Domain/Currency';

import { NettingRecordedEvent } from '@Contexts/Settlements/Domain/Netting/Events/NettingEvents';
import {
  CurrencyNotSupported,
  NettingWithSelf,
  NothingToNet,
} from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

/**
 * What two people netted across their groups (request 32): who asked, with whom, in which currency, the amount netted, and the
 * settlements that moved it, in the order they were made. The settlements are decided and kept by their groups' books, in the same
 * transaction; the netting keeps only their ids. It is read by the two people, and by no one else.
 */
export class Netting extends AggregateRoot {
  private constructor(
    id: Id,
    readonly by: Id,
    readonly withAccount: Id,
    readonly currency: string,
    readonly amount: number,
    readonly settlementIds: readonly Id[],
  ) {
    super(id, 0);
  }

  /** A request to net is refused before anything is read: with oneself, or in a currency Tally does not keep. */
  static checkRequest({ by, withAccount, currency }: { by: Id; withAccount: Id; currency: string }): IResult {
    if (by.value === withAccount.value) return Result.fail(new NettingWithSelf());
    if (!(CURRENCIES as readonly string[]).includes(currency)) return Result.fail(new CurrencyNotSupported());
    return Result.ok();
  }

  /**
   * Records a netting that was decided: refused when the request is refused (see `checkRequest`), or for an amount that is not at least
   * 1 (nothing to net). A netting records its event; its groups' settlements were decided and kept by their books.
   */
  static create({
    by,
    withAccount,
    currency,
    amount,
    settlementIds,
  }: {
    by: Id;
    withAccount: Id;
    currency: string;
    amount: number;
    settlementIds: Id[];
  }): IResult<Netting> {
    const request = Netting.checkRequest({ by, withAccount, currency });
    if (request.isFailure()) return request;
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new NothingToNet());

    const netting = new Netting(Id.generate(), by, withAccount, currency, amount, settlementIds);
    netting.record(
      NettingRecordedEvent.set({
        nettingId: netting._id.value,
        by: by.value,
        withAccount: withAccount.value,
        currency,
        amount,
        settlementIds: settlementIds.map(settlementId => settlementId.value),
      }),
    );
    return Result.ok(netting);
  }
}
