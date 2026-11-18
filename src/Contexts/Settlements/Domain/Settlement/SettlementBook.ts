import { AggregateRoot, Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import { SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  InvalidSettlementAmountException,
  PayeeHasNoPayoutAccountException,
  SettlementExceedsDebtException,
  SettlementNotRefundableException,
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
  /** Whether the group is archived, as Groups says it now (request 27): an archived group takes no settlement. */
  archived: boolean;
  at: Date;
}

/**
 * What a member asks to pay through the provider: the payer is the caller (`by`), the payee `to`; the rest as for a cash one, and the payee's
 * payout account as its PayoutAccount reads it now: `undefined` when the payee has none (request 16).
 */
export interface RequestProviderPaymentCommand {
  by: string;
  to: string;
  amount: number;
  members: string[];
  balances: { payer: number; payee: number };
  payoutAccount: string | undefined;
  /** Whether the group is archived, as Groups says it now (request 27): an archived group asks no provider for a payment. */
  archived: boolean;
  at: Date;
}

/** A settlement the provider is asked to pay: its id, which is the reference the provider is given, and the payee's payout account (request 16). */
export interface ProviderReservation {
  settlementId: string;
  payee: string;
}

/** What a payee asks to refund: the caller (`by`), the settlement, and the members of the group as Groups lists them now. */
export interface RefundSettlementCommand {
  by: string;
  settlementId: string;
  members: string[];
  /** Whether the group is archived, as Groups says it now (request 27): an archived group refunds nothing. */
  archived: boolean;
}

/** A settlement through the provider whose payment the provider has not ended yet: it waits for the provider's webhook (request 13). */
export interface PendingSettlement {
  id: string;
  from: string;
  to: string;
  amount: number;
  /** The provider's id for the payment: what its webhooks name. */
  providerPaymentId: string;
}

/**
 * A settlement through the provider that is paid, and whose payment may be refunded (request 15): `paid` until its payee asks for the
 * refund, `refunding` once it did. Its webhook `refunded` moves it on, once.
 */
export interface PaidSettlement extends PendingSettlement {
  status: 'paid' | 'refunding';
}

/** What the provider answered for a reserved settlement: the link where the payer pays, and the id the provider gave the payment. */
export interface ProviderPaymentLink {
  settlementId: string;
  providerPaymentId: string;
  payUrl: string;
}

/** A settlement the book adds to its rows: the view, and the provider's payment id when it is paid through the provider. */
export type NewSettlement = SettlementView & { providerPaymentId?: string };

/**
 * A settlement whose status the book moves: a pending one the provider ended (`paid`, `failed`, or `refunded` when the refund overtook the
 * success), a paid one whose refund was asked (`refunding`), or one the provider says was refunded (`refunded`).
 */
export interface MovedSettlement {
  id: string;
  status: 'paid' | 'failed' | 'refunding' | 'refunded';
  /** When Tally learned the new status, as an ISO string: the time its history line carries (request 19). */
  at: string;
}

/**
 * A change of money the book made since it was read, which the store writes to the group's audit in its own transaction (request 28,
 * docs/adr/0027): a cash settlement recorded, or a provider's payment that succeeded (`settlement-paid`, by its payee, or by its payer
 * through the provider), or a settlement the balances counted that the provider says was refunded (`settlement-refunded`, by its payee).
 */
export interface AuditedSettlementChange {
  id: string;
  action: 'settlement-paid' | 'settlement-refunded';
  by: string;
  subjectId: string;
  amount: number;
  at: string;
}

/** A refund asked now: the settlement's refund command, and the time Tally asked for it (request 19: the status it moves to is dated). */
export type RecordRefundCommand = RefundSettlementCommand & { at: Date };

/**
 * The settlements of one group, decided in one place (conventions/domain.yaml, the Settlements context; docs/adr/0013, docs/adr/0014,
 * docs/adr/0015). The book is the group's: its identity is the group's id, born with the group and taken up as it is (DOMAIN-IDENTITY). Its
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
 * - `reserveRefund()` decides a refund of a paid settlement through the provider: its payee asks, both members are still in the group,
 *   and it is paid. Nothing is recorded; the provider is asked after it, and `recordRefund()` then moves it to `refunding`, as
 *   `RefundRequested`. The balances still count a refunding settlement.
 * - `settleProviderPayment()` moves a settlement when the provider's webhook says its payment ended, once: `succeeded` or `failed` for a
 *   pending payment, `refunded` for a payment that is pending, paid or refunding (as `SettlementRefunded`). Any other status, or a payment
 *   that has no more to say, changes nothing.
 *
 * `fromSnapshot()` reads what the store kept, with the settlements of the group still waiting on the provider, records nothing, and
 * throws on corrupted data. The book does not hold every settlement of the group: it holds the ones recorded since it was read, and the
 * provider's ones that a webhook or a refund may still move.
 */
export class SettlementBook extends AggregateRoot {
  #pending: PendingSettlement[];
  #paid: PaidSettlement[];
  #recorded: NewSettlement[] = [];
  #moved: MovedSettlement[] = [];
  #audited: AuditedSettlementChange[] = [];

  private constructor(groupId: Id, version: number, pending: PendingSettlement[], paid: PaidSettlement[]) {
    super(groupId, version);
    this.#pending = pending;
    this.#paid = paid;
  }

  /**
   * The book as the store kept it, at the version it was read at: 0 when no settlement of the group is recorded yet, the settlements of
   * the group still pending, and the provider's paid ones, each with the provider's payment id it waits on or was paid by.
   */
  static fromSnapshot({
    groupId,
    version,
    pending = [],
    paid = [],
  }: {
    groupId: string;
    version: number;
    pending?: PendingSettlement[];
    paid?: PaidSettlement[];
  }): SettlementBook {
    if (!groupId || !Number.isInteger(version) || version < 0) {
      throw new Error(`A settlement book is corrupted: group ${groupId}, version ${version}`);
    }
    const corrupted = [...pending, ...paid].some(
      ({ id, providerPaymentId, amount }) => !id || !providerPaymentId || !(amount >= 1),
    );
    if (corrupted)
      throw new Error(`A settlement book is corrupted: group ${groupId} has a settlement without its payment`);
    const badStatus = paid.some(({ status }) => status !== 'paid' && status !== 'refunding');
    if (badStatus)
      throw new Error(`A settlement book is corrupted: group ${groupId} has a paid settlement of another status`);
    return new SettlementBook(new Id(groupId), version, [...pending], [...paid]);
  }

  get groupId(): string {
    return this._id.value;
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get recorded(): readonly NewSettlement[] {
    return this.#recorded;
  }

  /** The settlements whose status the book moved since it was read, in the order they moved: the store writes each one. */
  get moved(): readonly MovedSettlement[] {
    return this.#moved;
  }

  /** The changes of money the book made since it was read, in the order they were made: the store writes each one to the audit. */
  get audited(): readonly AuditedSettlementChange[] {
    return this.#audited;
  }

  /** The settlements of the group still pending, as the book was read and as recorded since. */
  get pending(): readonly PendingSettlement[] {
    return this.#pending;
  }

  /** The provider's settlements of the group that are paid, as the book was read: `refunding` once their refund was asked. */
  get paid(): readonly PaidSettlement[] {
    return this.#paid;
  }

  recordCash({
    by,
    from,
    amount,
    members,
    balances,
    archived,
    at,
  }: RecordCashSettlementCommand): IResult<SettlementView> {
    const decided = this.#decide({ from, to: by, amount, members, balances, archived });
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
    this.#audited.push({
      id: Id.generate().value,
      action: 'settlement-paid',
      by,
      subjectId: settlement.id,
      amount,
      at: at.toISOString(),
    });
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

  /**
   * Decides a settlement through the provider and reserves its id: the reference the provider is given, with the payee's payout account
   * the provider pays. Records nothing. A payee with no payout account is refused (`PayeeHasNoPayoutAccount`), before the provider is asked.
   */
  reserveProviderPayment(command: RequestProviderPaymentCommand): IResult<ProviderReservation> {
    const payee = this.#decideProvider(command);
    if (payee.isFailure()) return payee;
    return Result.ok({ settlementId: Id.generate().value, payee: payee.data });
  }

  /** Decides again with the provider's link in hand, and records the settlement pending, its payment waiting (request 13). */
  recordProviderPayment(command: RequestProviderPaymentCommand, link: ProviderPaymentLink): IResult<SettlementView> {
    const decided = this.#decideProvider(command);
    if (decided.isFailure()) return decided;
    const { by, to, amount, at } = command;

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
   * Decides a refund of a paid settlement through the provider and answers the provider's payment id it is refunded by. Only the payee
   * may ask (`NotAllowed` for another member); a settlement that is not paid through the provider, or whose payer or payee has left the
   * group, is refused (`SettlementNotRefundable`). Records nothing: the provider is asked after it.
   */
  reserveRefund(command: RefundSettlementCommand): IResult<PaidSettlement> {
    return this.#decideRefund(command);
  }

  /** Decides the refund again, and moves the settlement to `refunding`, as `RefundRequested`: the money has not gone back yet. */
  recordRefund(command: RecordRefundCommand): IResult<undefined> {
    const decided = this.#decideRefund(command);
    if (decided.isFailure()) return decided;

    const payment = decided.data;
    this.#paid = this.#paid.map(each => (each === payment ? { ...each, status: 'refunding' } : each));
    this.#moved.push({ id: payment.id, status: 'refunding', at: command.at.toISOString() });
    this.record(
      RefundRequestedEvent.set({
        settlementId: payment.id,
        groupId: this.groupId,
        from: payment.from,
        to: payment.to,
        amount: payment.amount,
      }),
    );
    return Result.ok(undefined);
  }

  /**
   * Moves the settlement whose payment the provider names, once, as the provider's status says: `succeeded` or `failed` for a pending
   * one, `refunded` for a pending, paid or refunding one. Any other status (`pending`, an unknown one), and a payment that has no more
   * to say, changes nothing, so a late or repeated webhook is harmless.
   */
  settleProviderPayment({
    providerPaymentId,
    status,
    at,
  }: {
    providerPaymentId: string;
    status: string;
    at: Date;
  }): void {
    if (status === 'refunded') return this.#refundedByProvider(providerPaymentId, at);

    const payment = this.#pending.find(each => each.providerPaymentId === providerPaymentId);
    if (!payment) return;
    if (status !== 'succeeded' && status !== 'failed') return;

    this.#pending = this.#pending.filter(each => each !== payment);
    const { id, from, to, amount } = payment;
    if (status === 'succeeded') {
      this.#moved.push({ id, status: 'paid', at: at.toISOString() });
      this.#audited.push({
        id: Id.generate().value,
        action: 'settlement-paid',
        by: from,
        subjectId: id,
        amount,
        at: at.toISOString(),
      });
      this.record(SettlementPaidEvent.set({ settlementId: id, groupId: this.groupId, from, to, amount }));
    } else {
      this.#moved.push({ id, status: 'failed', at: at.toISOString() });
      this.record(SettlementFailedEvent.set({ settlementId: id, groupId: this.groupId, from, to, amount }));
    }
  }

  /** The provider says the payment was refunded: a pending, paid or refunding settlement is refunded, and never counted again. */
  #refundedByProvider(providerPaymentId: string, at: Date): void {
    const pending = this.#pending.find(each => each.providerPaymentId === providerPaymentId);
    const payment: PendingSettlement | undefined =
      pending ?? this.#paid.find(each => each.providerPaymentId === providerPaymentId);
    if (!payment) return;
    // Only a settlement the balances counted (paid, or refunding) leaves them: a pending one that a refund overtook was never counted,
    // so the audit records no refund for it (docs/adr/0027).
    const counted = pending === undefined;

    this.#pending = this.#pending.filter(each => each !== payment);
    this.#paid = this.#paid.filter(each => each.providerPaymentId !== providerPaymentId);
    const { id, from, to, amount } = payment;
    this.#moved.push({ id, status: 'refunded', at: at.toISOString() });
    if (counted) {
      this.#audited.push({
        id: Id.generate().value,
        action: 'settlement-refunded',
        by: to,
        subjectId: id,
        amount,
        at: at.toISOString(),
      });
    }
    this.record(SettlementRefundedEvent.set({ settlementId: id, groupId: this.groupId, from, to, amount }));
  }

  /**
   * The rules of a settlement through the provider: the rules every settlement has (`#decide`), and a payee that has a payout account
   * (request 16). Answers the payout account the provider is asked to pay.
   */
  #decideProvider(command: RequestProviderPaymentCommand): IResult<string> {
    const { by, to, amount, members, balances, payoutAccount, archived } = command;
    const decided = this.#decide({ from: by, to, amount, members, balances, archived });
    if (decided.isFailure()) return decided;
    if (payoutAccount === undefined) return Result.fail(new PayeeHasNoPayoutAccountException());
    return Result.ok(payoutAccount);
  }

  /**
   * The refund rules: the settlement is a paid one through the provider this book holds; the caller is its payee; and its payer and
   * payee are still members of the group, so that the balances of the group still add up to 0 (request 9).
   */
  #decideRefund({ by, settlementId, members, archived }: RefundSettlementCommand): IResult<PaidSettlement> {
    if (archived) return Result.fail(new GroupArchivedException('Settlements'));
    const payment = this.#paid.find(each => each.id === settlementId && each.status === 'paid');
    if (!payment) return Result.fail(new SettlementNotRefundableException());
    if (payment.to !== by) {
      return Result.fail(new NotAllowedException('Settlements', 'Only the payee of a settlement may refund it'));
    }
    if (!members.includes(payment.from) || !members.includes(payment.to)) {
      return Result.fail(new SettlementNotRefundableException());
    }
    return Result.ok(payment);
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
    archived,
  }: {
    from: string;
    to: string;
    amount: number;
    members: string[];
    balances: { payer: number; payee: number };
    archived: boolean;
  }): IResult<undefined> {
    if (archived) return Result.fail(new GroupArchivedException('Settlements'));
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
