import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { SettlementRecordedEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  InvalidSettlementAmountException,
  SettlementExceedsDebtException,
  SettlementToSelfException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** What a member asks to record: the payee (`by`), the payer (`from`) and the amount, and what the decision reads of the group. */
export interface RecordCashSettlementCommand {
  by: string;
  from: string;
  amount: number;
  /** The members of the group, as Groups lists them now: the payer must be one of them. */
  members: string[];
  /** The payer's and the payee's balances, as Ledger counts them now (settlements included): what each is owed, or owes. */
  balances: { payer: number; payee: number };
  at: Date;
}

/**
 * The settlements of one group, decided in one place (conventions/domain.yaml, the Settlements context; docs/adr/0013). The
 * book is the group's: its identity is the group's id, born with the group and taken up as it is (DOMAIN-IDENTITY). Its
 * version is what the store checks on a save (CONC-OPTIMISTIC): two writers who read the same version cannot both record.
 *
 * `recordCash()` decides a cash settlement against the balances it is given, and never more than is owed: at most what the
 * payer owes (the opposite of their balance) and at most what the payee is owed (their balance), at the moment it is recorded.
 * It records `SettlementRecorded` for the store to make durable with it. `fromSnapshot()` reads what the store kept, records
 * nothing, and throws on corrupted data. The book does not hold every settlement of the group: it holds the ones recorded
 * since it was read, which the store saves.
 */
export class SettlementBook extends AggregateRoot {
  #recorded: SettlementView[] = [];

  private constructor(groupId: Id, version: number) {
    super(groupId, version);
  }

  /** The book as the store kept it, at the version it was read at: 0 when no settlement of the group is recorded yet. */
  static fromSnapshot({ groupId, version }: { groupId: string; version: number }): SettlementBook {
    if (!groupId || !Number.isInteger(version) || version < 0) {
      throw new Error(`A settlement book is corrupted: group ${groupId}, version ${version}`);
    }
    return new SettlementBook(new Id(groupId), version);
  }

  get groupId(): string {
    return this._id.value;
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get recorded(): readonly SettlementView[] {
    return this.#recorded;
  }

  recordCash({ by, from, amount, members, balances, at }: RecordCashSettlementCommand): IResult<SettlementView> {
    if (from === by) return Result.fail(new SettlementToSelfException());
    if (!members.includes(from)) return Result.fail(new NotFoundException('Settlements', 'There is no such member'));
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());

    const owed = Math.min(Math.max(0, -balances.payer), Math.max(0, balances.payee));
    if (amount > owed) return Result.fail(new SettlementExceedsDebtException());

    const settlement: SettlementView = {
      id: Id.generate().value,
      groupId: this.groupId,
      from,
      to: by,
      amount,
      method: 'cash',
      status: 'paid',
      at: at.toISOString(),
    };
    this.#recorded.push(settlement);
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id,
        groupId: this.groupId,
        from,
        to: by,
        amount,
      }),
    );
    return Result.ok(settlement);
  }
}
