import { AggregateRoot, Id } from '@Architecture/Domain';

import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementAnnulledEvent,
  SettlementContestedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementBookMergedEvent,
  SettlementRefundedEvent,
} from './SettlementEvents';
import { PendingTransfer, stillOwed } from './StillOwed';

/**
 * How a settlement is paid: in cash, recorded by its payee; through the payment provider (request 13); or by netting, which moves no money
 * and counts at once (request 32).
 */
export type SettlementMethod = 'cash' | 'provider' | 'net';

/**
 * Where a settlement stands: pending at the provider until its webhook says otherwise; paid; failed when the provider says so; being
 * refunded at the provider, the money not back yet (request 15); refunded, when the provider says so.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/** What an administrator decided about a contested settlement (request 33): the money arrived, or it did not. */
export type ContestDecision = 'decided-paid' | 'decided-annulled';

/** An entry of the administrators' log (request 33): which administrator decided what, about which settlement, and when. */
export interface AdministratorDecisionEntry {
  id: string;
  at: string;
  by: string;
  action: ContestDecision;
  subjectId: string;
}

/** A settlement as it is stored: a payment from one member of a group to another, recorded at `at`. */
export interface SettlementSnapshot {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  at: string;
  /** Through the provider only: the payment's id at the provider, and the link where the payer pays. */
  providerPaymentId?: string;
  payUrl?: string;
}

/**
 * A payment through the provider the book holds while it is live: waiting at the provider (`pending`), paid, or being refunded. It
 * carries the provider's id for it, which a refund is asked with. A payment that failed or was refunded is no longer held here.
 */
export interface ProviderPayment extends PendingTransfer {
  id: string;
  providerPaymentId: string;
  payUrl: string;
  status: 'pending' | 'paid' | 'refunding' | 'contested';
}

/**
 * The one place every settlement of a group is decided in (ADR 11, ADR 12, ADR 13): an aggregate per group, which carries the version it
 * was read at (CONC-OPTIMISTIC). Two settlements of one group decided at once both read the book at one version; the store saves the
 * first and refuses the second, which reads again and is decided on the balances with the first one counted. Its own identity is
 * generated here, once, when the book is first opened for its group.
 *
 * It holds the live payments through the provider: the ones waiting (counted as paid for what is still owed, `stillOwed`), the paid ones
 * a refund may be asked for, and the ones being refunded. `recordCash` records a settlement paid at once; `requestPayment` records one
 * pending at the provider, with its link; `settlePayment` moves a pending one to paid or failed, or any live one to refunded, when the
 * provider's webhook says so; `requestRefund` moves a paid one to refunding. Each records its event, published once the book is saved.
 */
export class SettlementBook extends AggregateRoot {
  readonly #groupId: string;
  #payments: ProviderPayment[];
  #recorded: SettlementSnapshot[] = [];
  #moved: { id: string; status: SettlementStatus; at: string; by?: string }[] = [];
  #decisions: AdministratorDecisionEntry[] = [];

  private constructor(id: Id, version: number, groupId: string, payments: ProviderPayment[]) {
    super(id, version);
    this.#groupId = groupId;
    this.#payments = payments;
  }

  /**
   * The group merged into this book's group (request 31): its settlements are this group's from the move on, and this book records
   * `SettlementBookMerged`. The status and the history of each settlement are kept.
   */
  absorb(mergedGroupId: string): void {
    this.record(SettlementBookMergedEvent.set({ groupId: this.#groupId, mergedGroupId }));
  }

  /** The book of a group with no settlement stored yet: version 0, its id generated here. */
  static open(groupId: string): SettlementBook {
    return new SettlementBook(Id.generate(), 0, groupId, []);
  }

  /**
   * Rebuilds the book as it is stored, at the version it was stored at, with the live payments through the provider. Records nothing;
   * throws on a version no save could store.
   */
  static fromSnapshot({
    id,
    groupId,
    version,
    payments,
  }: {
    id: string;
    groupId: string;
    version: number;
    payments: ProviderPayment[];
  }): SettlementBook {
    if (!Number.isInteger(version) || version < 1) throw new Error(`The stored settlement book ${id} is corrupted`);
    return new SettlementBook(new Id(id), version, groupId, payments);
  }

  get bookId(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  recorded(): readonly SettlementSnapshot[] {
    return this.#recorded;
  }

  /**
   * The statuses the settlements of this book moved to since it was read, in the order they moved, each with the time Tally learned
   * it: what the store updates, and what each settlement's history gains (request 19).
   */
  moved(): readonly { id: string; status: SettlementStatus; at: string; by?: string }[] {
    return this.#moved;
  }

  /** The administrators' decisions made in this book since it was read, in the order they were made: what the store logs (request 33). */
  decisions(): readonly AdministratorDecisionEntry[] {
    return this.#decisions;
  }

  /**
   * The payments that wait: pending at the provider, or contested by their payee until an administrator decides (request 33). What is
   * still owed counts them as paid, and the balances count neither.
   */
  pendingPayments(): readonly ProviderPayment[] {
    return this.#payments.filter(payment => payment.status === 'pending' || payment.status === 'contested');
  }

  /** The provider's id of the live payment of this settlement, if the book holds it: what a refund is asked of the provider with. */
  providerPaymentOf(settlementId: string): string | undefined {
    return this.#payments.find(payment => payment.id === settlementId)?.providerPaymentId;
  }

  /**
   * What the members still owe, given the balances the ledger counts (the paid settlements): the waiting payments count as paid
   * (`stillOwed`, ADR 12). The decisions of the rule and of the suggestions are made on these.
   */
  stillOwed(balances: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
    return stillOwed(balances, this.pendingPayments());
  }

  /**
   * Records a settlement paid in cash by `from` to `to`, at `at`, whose values the decision has allowed. Generates the
   * settlement's id and records `SettlementRecorded`, published once the book is saved. Answers the new settlement's id.
   */
  recordCash({ from, to, amount, at }: { from: string; to: string; amount: number; at: Date }): string {
    const id = Id.generate().value;
    this.#recorded = [...this.#recorded, this.#paidSnapshot(id, 'cash', { from, to, amount, at })];
    this.record(
      SettlementRecordedEvent.set({ settlementId: id, groupId: this.#groupId, payer: from, payee: to, amount }),
    );
    return id;
  }

  /**
   * Records a settlement made by netting (request 32): `from` pays `to` `amount`, paid at once, as a cash settlement is, and counted by the
   * balances at once. Generates the settlement's id and records `SettlementRecorded`, published once the book is saved. Answers the id.
   */
  recordNet({ from, to, amount, at }: { from: string; to: string; amount: number; at: Date }): string {
    const id = Id.generate().value;
    this.#recorded = [...this.#recorded, this.#paidSnapshot(id, 'net', { from, to, amount, at })];
    this.record(
      SettlementRecordedEvent.set({ settlementId: id, groupId: this.#groupId, payer: from, payee: to, amount }),
    );
    return id;
  }

  /** A settlement paid at once, as it is stored: its method is the one it was recorded by. */
  #paidSnapshot(
    id: string,
    method: 'cash' | 'net',
    { from, to, amount, at }: { from: string; to: string; amount: number; at: Date },
  ): SettlementSnapshot {
    return { id, groupId: this.#groupId, from, to, amount, method, status: 'paid', at: at.toISOString() };
  }

  /**
   * Records a payment through the provider, pending, with the provider's payment id and the link the payer pays at. `id` is the
   * settlement's id, which the decision generated and sent to the provider as the payment's reference. It records `PaymentRequested`.
   * The link is what the provider answered, checked by the adapter; the save checks that nothing else was decided since the book was read.
   */
  requestPayment({
    id,
    from,
    to,
    amount,
    at,
    providerPaymentId,
    payUrl,
  }: {
    id: string;
    from: string;
    to: string;
    amount: number;
    at: Date;
    providerPaymentId: string;
    payUrl: string;
  }): void {
    if (!providerPaymentId || !payUrl) throw new Error('A payment through the provider needs its id and its link');
    this.#payments = [...this.#payments, { id, from, to, amount, providerPaymentId, payUrl, status: 'pending' }];
    this.#recorded = [
      ...this.#recorded,
      {
        id,
        groupId: this.#groupId,
        from,
        to,
        amount,
        method: 'provider',
        status: 'pending',
        at: at.toISOString(),
        providerPaymentId,
        payUrl,
      },
    ];
    this.record(
      PaymentRequestedEvent.set({ settlementId: id, groupId: this.#groupId, payer: from, payee: to, amount }),
    );
  }

  /**
   * The provider's verdict on a payment: paid or failed for a pending one (it succeeded, or it failed), or refunded for one that is live
   * whatever it is: pending (the refund overtook its success), paid, or being refunded (request 15). A payment moves forward only, so a
   * payment that is not waiting is left as it is for paid and failed, and one already refunded is no longer held, so it is left alone
   * too: a webhook counts once (ADR 12). Records `SettlementPaid`, `SettlementFailed` or `SettlementRefunded`, and moves the settlement
   * to the status at `at`, the time Tally learned it (request 19). A webhook that changes nothing moves nothing.
   */
  settlePayment(providerPaymentId: string, outcome: 'paid' | 'failed' | 'refunded', at: Date): void {
    const payment = this.#payments.find(live => live.providerPaymentId === providerPaymentId);
    if (!payment) return;
    // A contested payment waits for an administrator: what the provider says about it changes nothing (request 33).
    if (payment.status === 'contested') return;
    if (outcome !== 'refunded' && payment.status !== 'pending') return;
    // A paid payment stays held, since a refund is asked for it; a failed or refunded one is no longer live.
    this.#payments =
      outcome === 'paid'
        ? this.#payments.map(live => (live === payment ? { ...live, status: 'paid' } : live))
        : this.#payments.filter(live => live !== payment);
    this.#moved = [...this.#moved, { id: payment.id, status: outcome, at: at.toISOString() }];
    const fact = {
      settlementId: payment.id,
      groupId: this.#groupId,
      payer: payment.from,
      payee: payment.to,
      amount: payment.amount,
    };
    if (outcome === 'paid') this.record(SettlementPaidEvent.set(fact));
    else if (outcome === 'failed') this.record(SettlementFailedEvent.set(fact));
    else this.record(SettlementRefundedEvent.set(fact));
  }

  /**
   * Asks the book to refund a paid settlement through the provider (request 15): it is refunding, and still counted, until the provider
   * says it is refunded. The decision has allowed it and the provider has accepted the refund; the save checks the book has not moved.
   * Records `RefundRequested`, published once the book is saved, and moves the settlement to refunding at `at`, the time Tally learned it.
   */
  requestRefund(settlementId: string, at: Date): void {
    const payment = this.#payments.find(live => live.id === settlementId);
    if (!payment || payment.status !== 'paid') {
      throw new Error(`The settlement ${settlementId} is not paid in its book, so it cannot be refunded`);
    }
    this.#payments = this.#payments.map(live => (live === payment ? { ...live, status: 'refunding' } : live));
    this.#moved = [...this.#moved, { id: payment.id, status: 'refunding', at: at.toISOString() }];
    this.record(
      RefundRequestedEvent.set({
        settlementId,
        groupId: this.#groupId,
        payer: payment.from,
        payee: payment.to,
        amount: payment.amount,
      }),
    );
  }

  /**
   * The payee contests a paid settlement (request 33): it is `contested` at `at`, the balances stop counting it and it waits, as a pending
   * payment does, until an administrator decides. The decision has allowed it. Records `SettlementContested`.
   */
  contest(settlementId: string, at: Date): void {
    const payment = this.#payments.find(live => live.id === settlementId);
    if (!payment || payment.status !== 'paid') {
      throw new Error(`The settlement ${settlementId} is not paid in its book, so it cannot be contested`);
    }
    this.#payments = this.#payments.map(live => (live === payment ? { ...live, status: 'contested' } : live));
    this.#moved = [...this.#moved, { id: payment.id, status: 'contested', at: at.toISOString() }];
    this.record(SettlementContestedEvent.set(this.#fact(payment)));
  }

  /**
   * An administrator decides a contested settlement (request 33): `paid` when the money arrived, and it is paid again, counted as it was
   * before it was contested; otherwise it is annulled, counted no more, and no longer waits. Either is an entry of the administrators' log,
   * written with the book. The decision has allowed it. Records `SettlementPaid` or `SettlementAnnulled`.
   */
  decideContest({ settlementId, paid, by, at }: { settlementId: string; paid: boolean; by: string; at: Date }): void {
    const payment = this.#payments.find(live => live.id === settlementId);
    if (!payment || payment.status !== 'contested') {
      throw new Error(`The settlement ${settlementId} is not contested in its book, so it cannot be decided`);
    }
    const status = paid ? 'paid' : 'annulled';
    this.#payments = paid
      ? this.#payments.map(live => (live === payment ? { ...live, status: 'paid' } : live))
      : this.#payments.filter(live => live !== payment);
    this.#moved = [...this.#moved, { id: payment.id, status, at: at.toISOString(), by }];
    this.#decisions = [
      ...this.#decisions,
      {
        id: Id.generate().value,
        at: at.toISOString(),
        by,
        action: paid ? 'decided-paid' : 'decided-annulled',
        subjectId: payment.id,
      },
    ];
    if (paid) this.record(SettlementPaidEvent.set(this.#fact(payment)));
    else this.record(SettlementAnnulledEvent.set(this.#fact(payment)));
  }

  #fact(payment: ProviderPayment) {
    return {
      settlementId: payment.id,
      groupId: this.#groupId,
      payer: payment.from,
      payee: payment.to,
      amount: payment.amount,
    };
  }
}
