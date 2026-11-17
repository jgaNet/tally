import { AggregateRoot, Id } from '@Architecture/Domain';

import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementRefundedEvent,
} from './SettlementEvents';
import { PendingTransfer, stillOwed } from './StillOwed';

/** How a settlement is paid: in cash, recorded by its payee, or through the payment provider (request 13). */
export type SettlementMethod = 'cash' | 'provider';

/**
 * Where a settlement stands: pending at the provider until its webhook says otherwise; paid; failed when the provider says so; being
 * refunded at the provider, the money not back yet (request 15); refunded, when the provider says so.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

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
  status: 'pending' | 'paid' | 'refunding';
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
  #moved: { id: string; status: SettlementStatus; at: string }[] = [];

  private constructor(id: Id, version: number, groupId: string, payments: ProviderPayment[]) {
    super(id, version);
    this.#groupId = groupId;
    this.#payments = payments;
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
  moved(): readonly { id: string; status: SettlementStatus; at: string }[] {
    return this.#moved;
  }

  /** The payments waiting at the provider, in the order they were requested. */
  pendingPayments(): readonly ProviderPayment[] {
    return this.#payments.filter(payment => payment.status === 'pending');
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
}
