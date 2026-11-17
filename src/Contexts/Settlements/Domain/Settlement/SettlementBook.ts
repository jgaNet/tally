import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import {
  GroupNotFoundException,
  InvalidSettlementAmountException,
  MoreThanPayeeIsOwedException,
  MoreThanPayerOwesException,
  PayeeIsPayerException,
  PayerNotInGroupException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { MemberBalance } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/** A settlement the payee records: who paid, and how much, in the group's currency's hundredths. The payee is the caller. */
export interface CashSettlementDraft {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

export type SettlementRecordedPayload = {
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  at: string;
};

/** A settlement was recorded: the balances count it from now on, and nothing reacts to it yet. */
export class SettlementRecordedEvent extends DomainEvent<SettlementRecordedPayload> {}

/** What a group's book is opened with: the group, the version it was read at, its members in join order, and their balances. */
export interface SettlementBookSnapshot {
  readonly groupId: string;
  readonly version: number;
  readonly members: readonly string[];
  readonly balances: readonly MemberBalance[];
}

/**
 * The book of a group's settlements (conventions/domain.yaml, ADR 10, the storm's `SettlementBook`): the one aggregate every
 * settlement of the group is decided in. It is opened with the members in the order they joined and the balances as the ledger
 * counts them, settlements included, so a settlement is decided against what is owed at the moment it is recorded. It carries
 * the version it was read at and never changes it: the store saves it at that version, or refuses it (CONC-OPTIMISTIC), so of
 * two settlements decided at once, the second is decided again on the first one's balances.
 */
export class SettlementBook extends AggregateRoot {
  readonly #members: readonly string[];
  readonly #balances: readonly MemberBalance[];

  private constructor(id: Id, version: number, members: readonly string[], balances: readonly MemberBalance[]) {
    super(id, version);
    this.#members = members;
    this.#balances = balances;
  }

  /** The group this book is the book of. */
  get groupId(): string {
    return this._id.value;
  }

  /** Opens the book as it was read. Records nothing: a book is read, not created (feature 12). */
  static open({ groupId, version, members, balances }: SettlementBookSnapshot): SettlementBook {
    return new SettlementBook(
      new Id(groupId),
      version,
      [...members],
      balances.map(row => ({ ...row })),
    );
  }

  /** Whether the account is a member of the group now. */
  hasMember(memberId: string): boolean {
    return this.#members.includes(memberId);
  }

  /** What the member owes (negative) or is owed (positive) in the group, in hundredths; a member nothing has counted is 0. */
  balanceOf(memberId: string): number {
    return this.#balances.find(row => row.memberId === memberId)?.balance ?? 0;
  }

  /**
   * Records a settlement in cash, decided by its payee (request 12). Refused, and nothing recorded, unless: the payee is a member
   * of the group (else the group's `404`), the amount is a whole number of 1 or more, the payer is a member and not the payee,
   * the amount is no more than the payer owes, and no more than the payee is owed. Otherwise it is recorded as paid, with its
   * identity generated here (DOMAIN-IDENTITY), and SettlementRecorded is recorded with it. The time is `now`.
   */
  recordCash({ from, to, amount }: CashSettlementDraft, now: Date): IResult<Settlement> {
    if (!this.hasMember(to)) return Result.fail(new GroupNotFoundException());
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());
    if (from === to) return Result.fail(new PayeeIsPayerException());
    if (!this.hasMember(from)) return Result.fail(new PayerNotInGroupException());
    if (amount > -this.balanceOf(from)) return Result.fail(new MoreThanPayerOwesException());
    if (amount > this.balanceOf(to)) return Result.fail(new MoreThanPayeeIsOwedException());

    const settlement: Settlement = {
      id: Id.generate().value,
      groupId: this.groupId,
      from,
      to,
      amount,
      method: 'cash',
      status: 'paid',
      at: now.toISOString(),
    };
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id,
        groupId: settlement.groupId,
        from,
        to,
        amount,
        at: settlement.at,
      }),
    );
    return Result.ok(settlement);
  }
}
