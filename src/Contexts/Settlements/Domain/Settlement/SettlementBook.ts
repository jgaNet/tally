import { AggregateRoot, IResult, Id, Result } from '@Architecture/Domain';

import { ISettlementBookSnapshot, ISettlementSnapshot } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  InvalidSettlementAmountException,
  SettlementExceedsBalanceException,
  SettlementPayerNotMemberException,
  SettlementToSelfException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { SettlementRecordedEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';

/** A balance as the decision reads it: the member's balance in the group, positive when owed, negative when owing. */
export interface BalanceOfMember {
  memberId: string;
  balance: number;
}

/**
 * SettlementBook is the aggregate root of the settlements of one group, the one place they are decided in, so that two
 * settlements recorded at once cannot pay more than is owed (request 12, the storm `settle-in-cash`, ADR 8).
 *
 * A settlement is one transfer of cash from a payer to a payee of the group. It is decided against the balances as they
 * are at the moment it is recorded, which the handler reads through the port Settlements owns (`IGroupBalances`) in the
 * same transaction as the book's version: a settlement's amount is a whole number of at least 1, the payer is a member
 * other than the payee, and the amount is at most what the payer owes and at most what the payee is owed. Otherwise it
 * is refused, and the book does not change.
 *
 * The book's version is the check (CONC-OPTIMISTIC): a save is refused when another writer saved first, and the command
 * handler re-reads the book and the balances and decides again. The book records `SettlementRecorded` for each settlement
 * it decides, and publishes nothing itself.
 */
export class SettlementBook extends AggregateRoot {
  readonly #groupId: string;
  readonly #settlements: ISettlementSnapshot[] = [];

  private constructor(id: Id, groupId: string, version: number) {
    super(id, version);
    this.#groupId = groupId;
  }

  /** The book of a group that has no settlement yet: at version 0, with the identity the domain generates. Records nothing. */
  static open(groupId: string): SettlementBook {
    return new SettlementBook(Id.generate(), groupId, 0);
  }

  /** The book as the store holds it, at the version it was read at. Records nothing. */
  static fromSnapshot({ _id, groupId, version }: { _id: string; groupId: string; version: number }): SettlementBook {
    return new SettlementBook(new Id(_id), groupId, version);
  }

  /**
   * Records a settlement that `payer` paid `payee` in cash, of `amount`, at `at`, decided against `balances` as the group
   * has them now. `members` are the group's current members, as Groups answers them. The settlement is kept in the book
   * until it is saved and records `SettlementRecorded`; a refused settlement records nothing and changes nothing.
   */
  recordCash({
    payer,
    payee,
    amount,
    at,
    members,
    balances,
  }: {
    payer: string;
    payee: string;
    amount: number;
    at: Date;
    members: string[];
    balances: BalanceOfMember[];
  }): IResult<ISettlementSnapshot> {
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());
    if (payer === payee) return Result.fail(new SettlementToSelfException());
    if (!members.includes(payer)) return Result.fail(new SettlementPayerNotMemberException());

    const balanceOf = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
    const owedByPayer = Math.max(0, -(balanceOf.get(payer) ?? 0));
    const owedToPayee = Math.max(0, balanceOf.get(payee) ?? 0);
    if (amount > owedByPayer || amount > owedToPayee) return Result.fail(new SettlementExceedsBalanceException());

    const settlement: ISettlementSnapshot = {
      _id: Id.generate().value,
      groupId: this.#groupId,
      from: payer,
      to: payee,
      amount,
      at: at.toISOString(),
    };
    this.#settlements.push(settlement);
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement._id,
        groupId: this.#groupId,
        from: payer,
        to: payee,
        amount,
      }),
    );
    return Result.ok(settlement);
  }

  /** The book as the store writes it: the settlements recorded since it was read, with the version it was read at. */
  toSnapshot(): ISettlementBookSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      version: this.version,
      settlements: [...this.#settlements],
    };
  }
}
