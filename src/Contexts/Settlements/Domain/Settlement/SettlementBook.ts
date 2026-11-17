import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { SettlementRecordedEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  InvalidSettlementAmount,
  PayerIsPayee,
  PayerNotAMember,
  SettlementExceedsDebt,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** A settlement the book decided: its id, its group, who paid whom, how much, and when it was recorded. */
export interface DecidedSettlement {
  readonly id: Id;
  readonly groupId: Id;
  readonly payer: Id;
  readonly payee: Id;
  readonly amount: number;
  readonly at: Date;
}

/**
 * The settlements of one group, decided in one place (conventions/domain.yaml, ADR 7). A payee records, in cash, a payment
 * a member made them, and the book refuses it unless the amount is a whole number of at least 1, the payer is a member of
 * the group and not the payee, and the amount is no more than what the payer owes and no more than what the payee is owed,
 * on the balances it is given. The caller reads the balances in the same transaction; the book's version (CONC-OPTIMISTIC)
 * makes a second settlement decided at once re-read them, so the first one's is in them. Records SettlementRecorded.
 */
export class SettlementBook extends AggregateRoot {
  #decided: DecidedSettlement[] = [];

  private constructor(groupId: Id, version: number) {
    super(groupId, version);
  }

  /** The book of a group, at the version it was read at; 0 when no settlement was ever recorded in it. */
  static open(groupId: Id, version: number): SettlementBook {
    return new SettlementBook(groupId, version);
  }

  recordCash({
    payer,
    payee,
    amount,
    balances,
    members,
    at,
  }: {
    payer: Id;
    payee: Id;
    amount: number;
    balances: ReadonlyMap<string, number>;
    members: readonly string[];
    at: Date;
  }): IResult<DecidedSettlement> {
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmount());
    if (payer.equals(payee)) return Result.fail(new PayerIsPayee());
    if (!members.includes(payer.value)) return Result.fail(new PayerNotAMember());

    const owedByPayer = Math.max(0, -(balances.get(payer.value) ?? 0));
    const owedToPayee = Math.max(0, balances.get(payee.value) ?? 0);
    if (amount > owedByPayer || amount > owedToPayee) return Result.fail(new SettlementExceedsDebt());

    const decided: DecidedSettlement = { id: Id.generate(), groupId: this._id, payer, payee, amount, at };
    this.#decided.push(decided);
    this.record(
      SettlementRecordedEvent.set({
        settlementId: decided.id.value,
        groupId: this._id.value,
        payer: payer.value,
        payee: payee.value,
        amount,
        recordedAt: at.toISOString(),
      }),
    );
    return Result.ok(decided);
  }

  /** The settlements this book decided since it was read, for the repository to store with it. */
  get decided(): readonly DecidedSettlement[] {
    return this.#decided;
  }
}
