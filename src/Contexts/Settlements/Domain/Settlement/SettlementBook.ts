import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  PaymentRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  InvalidSettlementAmountException,
  SettlementExceedsDebtException,
  SettlementToSelfException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { stillBalance, Waiting } from '@Contexts/Settlements/Domain/Settlement/StillOwed';

/** What a member asks to record: the payee (`by`), the payer (`from`) and the amount, and what the decision reads of the group. */
export interface RecordCashSettlementCommand {
  by: string;
  from: string;
  amount: number;
  /** The members of the group, as Groups lists them now: the payer must be one of them. */
  members: string[];
  /** The payer's and the payee's balances, as Ledger counts them now (settlements paid included): what each is owed, or owes. */
  balances: { payer: number; payee: number };
  at: Date;
}

/** What a member asks to pay through the provider: the payer is the caller (`by`), the payee `to`; the rest as for a cash one. */
export interface RequestProviderPaymentCommand {
  by: string;
  to: string;
  amount: number;
  members: string[];
  balances: { payer: number; payee: number };
  at: Date;
}

/** A settlement through the provider that is pending: it waits for the provider to say its payment ended (request 13). */
export interface PendingSettlement {
  id: string;
  from: string;
  to: string;
  amount: number;
  /** The provider's id for the payment: what its webhooks name. */
  providerPaymentId: string;
}

/** What the provider answered for a reserved settlement: the link where the payer pays, and the id the provider gave the payment. */
export interface ProviderPaymentLink {
  settlementId: string;
  providerPaymentId: string;
  payUrl: string;
}

/** A settlement the book adds to its rows: the view, and the provider's payment id when it is paid through the provider. */
export type NewSettlement = SettlementView & { providerPaymentId?: string };

/** A pending settlement the provider ended, whose status the book moves: `paid` or `failed`. */
export interface EndedSettlement {
  id: string;
  status: 'paid' | 'failed';
}

/**
 * The settlements of one group, decided in one place (conventions/domain.yaml, the Settlements context; docs/adr/0013, docs/adr/0014).
 * The book is the group's: its identity is the group's id, born with the group and taken up as it is (DOMAIN-IDENTITY). Its
 * version is what the store checks on a save (CONC-OPTIMISTIC): two writers who read the same version cannot both record.
 *
 * Every settlement is decided here, cash and provider alike, against the balances it is given and the pending settlements the
 * book holds: what a member still owes is its debt less what it is waiting to pay, and what it is still owed is its credit less
 * what is waiting to be paid to it (`stillBalance()`). A settlement is never more than that, at the moment it is decided.
 *
 * - `recordCash()` records a cash settlement, paid at once.
 * - `reserveProviderPayment()` decides a settlement through the provider and reserves its id, which the provider is given as the
 *   payment's reference; nothing is recorded. The provider is asked after it: an answer that is not a link refuses the settlement.
 * - `recordProviderPayment()` decides again with the link in hand, and records the settlement pending, as `PaymentRequested`.
 * - `settleProviderPayment()` moves a pending settlement to `paid` or `failed` when the provider's webhook says its payment ended,
 *   once: a payment that is not pending any more, or a status that is not an end, changes nothing.
 *
 * `fromSnapshot()` reads what the store kept, with the pending settlements of the group, records nothing, and throws on corrupted
 * data. The book does not hold every settlement of the group: it holds the ones recorded since it was read, and the ones pending.
 */
export class SettlementBook extends AggregateRoot {
  #pending: PendingSettlement[];
  #recorded: NewSettlement[] = [];
  #ended: EndedSettlement[] = [];

  private constructor(groupId: Id, version: number, pending: PendingSettlement[]) {
    super(groupId, version);
    this.#pending = pending;
  }

  /**
   * The book as the store kept it, at the version it was read at: 0 when no settlement of the group is recorded yet, and the
   * settlements of the group still pending, with the provider's payment id each waits on.
   */
  static fromSnapshot({
    groupId,
    version,
    pending = [],
  }: {
    groupId: string;
    version: number;
    pending?: PendingSettlement[];
  }): SettlementBook {
    if (!groupId || !Number.isInteger(version) || version < 0) {
      throw new Error(`A settlement book is corrupted: group ${groupId}, version ${version}`);
    }
    const corrupted = pending.some(({ id, providerPaymentId, amount }) => !id || !providerPaymentId || !(amount >= 1));
    if (corrupted)
      throw new Error(`A settlement book is corrupted: group ${groupId} has a pending settlement without its payment`);
    return new SettlementBook(new Id(groupId), version, [...pending]);
  }

  get groupId(): string {
    return this._id.value;
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get recorded(): readonly NewSettlement[] {
    return this.#recorded;
  }

  /** The pending settlements the provider ended since the book was read, whose status the store moves. */
  get ended(): readonly EndedSettlement[] {
    return this.#ended;
  }

  /** The settlements of the group still pending, as the book was read and as recorded since. */
  get pending(): readonly PendingSettlement[] {
    return this.#pending;
  }

  recordCash({ by, from, amount, members, balances, at }: RecordCashSettlementCommand): IResult<SettlementView> {
    const decided = this.#decide({ from, to: by, amount, members, balances });
    if (decided.isFailure()) return decided;

    const settlement: NewSettlement = {
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

  /** Decides a settlement through the provider and reserves its id: the reference the provider is given. Records nothing. */
  reserveProviderPayment({ by, to, amount, members, balances }: RequestProviderPaymentCommand): IResult<string> {
    const decided = this.#decide({ from: by, to, amount, members, balances });
    if (decided.isFailure()) return decided;
    return Result.ok(Id.generate().value);
  }

  /** Decides again with the provider's link in hand, and records the settlement pending, its payment waiting (request 13). */
  recordProviderPayment(
    { by, to, amount, members, balances, at }: RequestProviderPaymentCommand,
    link: ProviderPaymentLink,
  ): IResult<SettlementView> {
    const decided = this.#decide({ from: by, to, amount, members, balances });
    if (decided.isFailure()) return decided;

    const settlement: NewSettlement = {
      id: link.settlementId,
      groupId: this.groupId,
      from: by,
      to,
      amount,
      method: 'provider',
      status: 'pending',
      at: at.toISOString(),
      payUrl: link.payUrl,
      providerPaymentId: link.providerPaymentId,
    };
    this.#recorded.push(settlement);
    this.#pending = [
      ...this.#pending,
      { id: settlement.id, from: by, to, amount, providerPaymentId: link.providerPaymentId },
    ];
    this.record(
      PaymentRequestedEvent.set({ settlementId: settlement.id, groupId: this.groupId, from: by, to, amount }),
    );
    return Result.ok(settlement);
  }

  /**
   * Moves the pending settlement whose payment the provider names to `paid` (`succeeded`) or `failed`, once. A `pending` status,
   * an unknown one, or a payment that is not pending any more changes nothing, so a late or repeated webhook is harmless.
   */
  settleProviderPayment({ providerPaymentId, status }: { providerPaymentId: string; status: string }): void {
    const payment = this.#pending.find(each => each.providerPaymentId === providerPaymentId);
    if (!payment) return;
    if (status !== 'succeeded' && status !== 'failed') return;

    this.#pending = this.#pending.filter(each => each !== payment);
    const { id, from, to, amount } = payment;
    if (status === 'succeeded') {
      this.#ended.push({ id, status: 'paid' });
      this.record(SettlementPaidEvent.set({ settlementId: id, groupId: this.groupId, from, to, amount }));
    } else {
      this.#ended.push({ id, status: 'failed' });
      this.record(SettlementFailedEvent.set({ settlementId: id, groupId: this.groupId, from, to, amount }));
    }
  }

  /**
   * The rules every settlement is decided by, with the balances as the book counts them now: the payer and the payee are
   * members and not the same member, the amount is a whole number of at least 1, and it is at most what the payer still owes
   * and at most what the payee is still owed.
   */
  #decide({
    from,
    to,
    amount,
    members,
    balances,
  }: {
    from: string;
    to: string;
    amount: number;
    members: string[];
    balances: { payer: number; payee: number };
  }): IResult<undefined> {
    if (from === to) return Result.fail(new SettlementToSelfException());
    if (!members.includes(from) || !members.includes(to)) {
      return Result.fail(new NotFoundException('Settlements', 'There is no such member'));
    }
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());

    const payer = stillBalance(balances.payer, this.#waitingOf(from));
    const payee = stillBalance(balances.payee, this.#waitingOf(to));
    const owed = Math.min(Math.max(0, -payer), Math.max(0, payee));
    if (amount > owed) return Result.fail(new SettlementExceedsDebtException());
    return Result.ok(undefined);
  }

  /** What one member is waiting to pay and to receive in the pending settlements of the book. */
  #waitingOf(memberId: string): Waiting {
    return this.#pending.reduce<Waiting>(
      (waiting, each) => ({
        paid: waiting.paid + (each.from === memberId ? each.amount : 0),
        received: waiting.received + (each.to === memberId ? each.amount : 0),
      }),
      { paid: 0, received: 0 },
    );
  }
}
