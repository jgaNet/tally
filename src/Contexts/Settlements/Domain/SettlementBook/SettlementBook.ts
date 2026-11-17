import { AggregateRoot, Id } from '@Architecture/Domain';

import {
  PaymentRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
} from './SettlementEvents';
import { PendingTransfer, stillOwed } from './StillOwed';

/** How a settlement is paid: in cash, recorded by its payee, or through the payment provider (request 13). */
export type SettlementMethod = 'cash' | 'provider';

/** Where a settlement stands: paid, or pending at the provider until its webhook says otherwise; failed when the provider says so. */
export type SettlementStatus = 'pending' | 'paid' | 'failed';

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

/** A payment waiting at the provider: a settlement whose status is `pending`, with the provider's id for it. */
export interface PendingPayment extends PendingTransfer {
  id: string;
  providerPaymentId: string;
  payUrl: string;
}

/**
 * The one place every settlement of a group is decided in (ADR 11, ADR 12): an aggregate per group, which carries the version it was
 * read at (CONC-OPTIMISTIC). Two settlements of one group decided at once both read the book at one version; the store saves the
 * first and refuses the second, which reads again and is decided on the balances with the first one counted. Its own identity is
 * generated here, once, when the book is first opened for its group.
 *
 * It holds the payments waiting at the provider, since what is still owed counts them as paid (`stillOwed`). `recordCash` records a
 * settlement paid at once; `requestPayment` records one pending at the provider, with its link; `settlePayment` moves a pending one to
 * paid or failed when the provider's webhook says so. Each records its event, published once the book is saved.
 */
export class SettlementBook extends AggregateRoot {
  readonly #groupId: string;
  #pending: PendingPayment[];
  #recorded: SettlementSnapshot[] = [];
  #settled: { id: string; status: 'paid' | 'failed' }[] = [];

  private constructor(id: Id, version: number, groupId: string, pending: PendingPayment[]) {
    super(id, version);
    this.#groupId = groupId;
    this.#pending = pending;
  }

  /** The book of a group with no settlement stored yet: version 0, its id generated here. */
  static open(groupId: string): SettlementBook {
    return new SettlementBook(Id.generate(), 0, groupId, []);
  }

  /**
   * Rebuilds the book as it is stored, at the version it was stored at, with the payments waiting at the provider. Records nothing;
   * throws on a version no save could store.
   */
  static fromSnapshot({
    id,
    groupId,
    version,
    pending,
  }: {
    id: string;
    groupId: string;
    version: number;
    pending: PendingPayment[];
  }): SettlementBook {
    if (!Number.isInteger(version) || version < 1) throw new Error(`The stored settlement book ${id} is corrupted`);
    return new SettlementBook(new Id(id), version, groupId, pending);
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

  /** The pending payments that were paid or failed since the book was read, in the order they moved: what the store updates. */
  settled(): readonly { id: string; status: 'paid' | 'failed' }[] {
    return this.#settled;
  }

  /** The payments waiting at the provider, in the order they were requested. */
  pendingPayments(): readonly PendingPayment[] {
    return this.#pending;
  }

  /** The payment waiting at the provider under this id, if it is waiting. */
  pendingPayment(providerPaymentId: string): PendingPayment | undefined {
    return this.#pending.find(payment => payment.providerPaymentId === providerPaymentId);
  }

  /**
   * What the members still owe, given the balances the ledger counts (the paid settlements): the waiting payments count as paid
   * (`stillOwed`, ADR 12). The decisions of the rule and of the suggestions are made on these.
   */
  stillOwed(balances: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
    return stillOwed(balances, this.#pending);
  }

  /**
   * Records a settlement paid in cash by `from` to `to`, at `at`, whose values the decision has allowed. Generates the
   * settlement's id and records `SettlementRecorded`, published once the book is saved. Answers the new settlement's id.
   */
  recordCash({ from, to, amount, at }: { from: string; to: string; amount: number; at: Date }): string {
    const id = Id.generate().value;
    this.#recorded = [
      ...this.#recorded,
      { id, groupId: this.#groupId, from, to, amount, method: 'cash', status: 'paid', at: at.toISOString() },
    ];
    this.record(
      SettlementRecordedEvent.set({ settlementId: id, groupId: this.#groupId, payer: from, payee: to, amount }),
    );
    return id;
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
    this.#pending = [...this.#pending, { id, from, to, amount, providerPaymentId, payUrl }];
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
   * The provider's verdict on a pending payment: paid (it succeeded) or failed. A pending payment moves once, forward only; a payment
   * that is not waiting here is left as it is, so a webhook counts once (ADR 12). Records `SettlementPaid` or `SettlementFailed`.
   */
  settlePayment(providerPaymentId: string, outcome: 'paid' | 'failed'): void {
    const payment = this.pendingPayment(providerPaymentId);
    if (!payment) return;
    this.#pending = this.#pending.filter(waiting => waiting !== payment);
    this.#settled = [...this.#settled, { id: payment.id, status: outcome }];
    const fact = {
      settlementId: payment.id,
      groupId: this.#groupId,
      payer: payment.from,
      payee: payment.to,
      amount: payment.amount,
    };
    if (outcome === 'paid') this.record(SettlementPaidEvent.set(fact));
    else this.record(SettlementFailedEvent.set(fact));
  }
}
