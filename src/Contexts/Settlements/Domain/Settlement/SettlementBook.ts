import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import {
  ExceedsWhatIsOwed,
  ExceedsWhatIsOwedToPayee,
  InvalidSettlementAmount,
  PaidToSelf,
  PayerNotAMember,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { SettlementRecordedEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * The one place every settlement of a group is decided in (the storm's T7): a book per group, with a version, so that two
 * writers who read the same book cannot both win (CONC-OPTIMISTIC). A settlement is decided against the balances the handler
 * reads inside its transaction: it never pays more than the payer owes, nor more than the payee is owed, at the moment it is
 * recorded. The book holds the settlements recorded in it since it was read; the repository stores them with its version.
 */
export class SettlementBook extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    version: number,
    private readonly made: Settlement[],
  ) {
    super(id, version);
  }

  /** The book of a group that has no settlement yet: it is opened by its first settlement, at version 0. */
  static open(groupId: Id): SettlementBook {
    return new SettlementBook(Id.generate(), groupId, 0, []);
  }

  /** The book as it is kept, at the version it was read at; it records nothing. */
  static fromSnapshot({ id, groupId, version }: { id: string; groupId: string; version: number }): SettlementBook {
    return new SettlementBook(new Id(id), new Id(groupId), version, []);
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get recorded(): readonly Settlement[] {
    return this.made;
  }

  /**
   * Records a payment in cash from `payer` to `payee` of `amount`, decided on the two balances as they are now: `payerBalance`
   * and `payeeBalance` are read by the handler inside its transaction, in the group's money (a negative balance is a debt).
   * `payerIsMember` is the handler's answer for the payer; the payee is the caller, whom the handler has checked is a member.
   * `now` is the application's clock, read by the handler: the settlement's time is a parameter, never a default.
   */
  recordCash({
    payer,
    payee,
    amount,
    payerIsMember,
    payerBalance,
    payeeBalance,
    now,
  }: {
    payer: Id;
    payee: Id;
    amount: number;
    payerIsMember: boolean;
    payerBalance: number;
    payeeBalance: number;
    now: Date;
  }): IResult<Settlement> {
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmount());
    if (!payerIsMember) return Result.fail(new PayerNotAMember());
    if (payer.value === payee.value) return Result.fail(new PaidToSelf());
    if (amount > Math.max(0, -payerBalance)) return Result.fail(new ExceedsWhatIsOwed());
    if (amount > Math.max(0, payeeBalance)) return Result.fail(new ExceedsWhatIsOwedToPayee());

    const settlement = new Settlement(Id.generate(), this.groupId, payer, payee, amount, now);
    this.made.push(settlement);
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id.value,
        groupId: this.groupId.value,
        payer: payer.value,
        payee: payee.value,
        amount,
      }),
    );
    return Result.ok(settlement);
  }
}
