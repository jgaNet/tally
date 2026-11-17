import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import {
  CashIsNotRefunded,
  ExceedsWhatIsOwed,
  ExceedsWhatIsOwedToPayee,
  InvalidSettlementAmount,
  OnlyAPaidSettlementIsRefunded,
  OnlyThePayeeMayRefund,
  PaidToSelf,
  PayeeNotAMember,
  PayerNotAMember,
  ProviderRefundUnavailable,
  ProviderUnavailable,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { PaymentOutcome, Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * What a settlement is decided on, read by the handler inside its transaction: the two balances as Ledger counts them (a negative
 * balance is a debt, in the group's money), and whether each member is a member of the group. The book adds what is waiting at
 * the provider to them: a payment waiting counts as if it were paid.
 */
export interface Decision {
  payer: Id;
  payee: Id;
  amount: number;
  payerIsMember: boolean;
  payeeIsMember: boolean;
  payerBalance: number;
  payeeBalance: number;
}

/** A payment through the provider, decided and named, not yet recorded: its id is the reference the provider is given. */
export interface PlannedPayment {
  readonly id: Id;
  readonly groupId: Id;
  readonly payer: Id;
  readonly payee: Id;
  readonly amount: number;
  readonly at: Date;
}

/** A refund decided and named, not yet recorded: the provider's id for the payment it refunds, and the settlement it is for. */
export interface PlannedRefund {
  readonly settlementId: string;
  readonly paymentId: string;
}

/** The payment link the provider gave for a payment: its id at the provider, and the link the payer pays at. */
export interface PaymentLink {
  readonly paymentId: string;
  readonly payUrl: string;
}

/**
 * The one place every settlement of a group is decided in (the storm's T7): a book per group, with a version, so that two writers
 * who read the same book cannot both win (CONC-OPTIMISTIC). A settlement is decided against the balances the handler reads inside
 * its transaction, and against what is waiting at the provider: it never pays more than the payer still owes, nor more than the
 * payee is still owed, at the moment it is recorded. The book holds every settlement of the group as it was read, and those
 * recorded or changed since; the repository stores them with its version.
 */
export class SettlementBook extends AggregateRoot {
  private readonly made: Settlement[] = [];
  private readonly statusChanged: Settlement[] = [];

  private constructor(
    id: Id,
    readonly groupId: Id,
    version: number,
    /** The settlements of the group, as read, and those recorded since, in the order they were kept. */
    private readonly settlements: Settlement[],
  ) {
    super(id, version);
  }

  /** The book of a group that has no settlement yet: it is opened by its first settlement, at version 0. */
  static open(groupId: Id): SettlementBook {
    return new SettlementBook(Id.generate(), groupId, 0, []);
  }

  /** The book as it is kept, at the version it was read at, with the group's settlements; it records nothing. */
  static fromSnapshot({
    id,
    groupId,
    version,
    settlements,
  }: {
    id: string;
    groupId: string;
    version: number;
    settlements: Settlement[];
  }): SettlementBook {
    return new SettlementBook(new Id(id), new Id(groupId), version, [...settlements]);
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get created(): readonly Settlement[] {
    return this.made;
  }

  /** The settlements whose status changed since the book was read: the provider said how their payment ended, or a refund was asked. */
  get statusChangedSinceRead(): readonly Settlement[] {
    return this.statusChanged;
  }

  /** The settlements of the group whose payment is waiting at the provider. */
  private get waiting(): Settlement[] {
    return this.settlements.filter(settlement => settlement.status === 'pending');
  }

  /**
   * Records a payment in cash from `payer` to `payee`, decided on the balances as they are now. `now` is the application's clock,
   * read by the handler: the settlement's time is a parameter, never a default.
   */
  recordCash({ now, ...decision }: Decision & { now: Date }): IResult<Settlement> {
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;

    const settlement = new Settlement(
      Id.generate(),
      this.groupId,
      decision.payer,
      decision.payee,
      decision.amount,
      'cash',
      'paid',
      now,
      null,
    );
    this.keep(settlement);
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id.value,
        groupId: this.groupId.value,
        payer: decision.payer.value,
        payee: decision.payee.value,
        amount: decision.amount,
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * First half of a payment through the provider: the rules decided now, and the id the payment is kept under, which the provider
   * is given as its reference. Nothing is recorded: when the provider gives no link, nothing was kept.
   */
  planPayment({ now, ...decision }: Decision & { now: Date }): IResult<PlannedPayment> {
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;

    return Result.ok({
      id: Id.generate(),
      groupId: this.groupId,
      payer: decision.payer,
      payee: decision.payee,
      amount: decision.amount,
      at: now,
    });
  }

  /**
   * Second half: the payment is kept pending with the provider's link, once the rules are decided again on the balances read after
   * the provider answered. A missing link (`null`) is the provider's refusal: nothing is kept.
   */
  recordPayment(planned: PlannedPayment, link: PaymentLink | null, decision: Decision): IResult<Settlement> {
    if (!link) return Result.fail(new ProviderUnavailable());
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;

    const settlement = new Settlement(
      planned.id,
      this.groupId,
      planned.payer,
      planned.payee,
      planned.amount,
      'provider',
      'pending',
      planned.at,
      { paymentId: link.paymentId, payUrl: link.payUrl },
    );
    this.keep(settlement);
    this.record(
      PaymentRequestedEvent.set({
        settlementId: settlement.id.value,
        groupId: this.groupId.value,
        payer: planned.payer.value,
        payee: planned.payee.value,
        amount: planned.amount,
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * The provider's webhook about one of the book's payments. The payment moves forward only: a pending one is paid or failed, a
   * paid one (or one being refunded) is refunded, and a pending one may be refunded straight away when the refund overtakes its
   * success. Anything else changes nothing: a payment Tally does not know, a status it does not know, a status the payment has gone
   * past (a `succeeded` after a refund, or `pending` at any time), and a webhook that comes twice (request 14, request 15). Returns
   * whether anything changed.
   */
  receivePayment(paymentId: string, status: string): boolean {
    const settlement = this.settlements.find(known => known.provider?.paymentId === paymentId);
    if (!settlement) return false;

    const outcome = outcomeOf(status);
    if (!outcome || !movesTo(settlement.status, outcome)) return false;

    settlement.end(outcome);
    this.statusChanged.push(settlement);
    const payload = {
      settlementId: settlement.id.value,
      groupId: this.groupId.value,
      payer: settlement.payer.value,
      payee: settlement.payee.value,
      amount: settlement.amount,
    };
    if (outcome === 'paid') this.record(SettlementPaidEvent.set(payload));
    else if (outcome === 'failed') this.record(SettlementFailedEvent.set(payload));
    else this.record(SettlementRefundedEvent.set(payload));
    return true;
  }

  /**
   * First half of a refund: the rules decided now. Only the payee of a settlement paid through the provider refunds it, and only
   * while it is paid; both members must still be members of the group, so that the balances still add up to 0. Nothing is recorded.
   */
  decideRefund(settlementId: Id, caller: Id, members: string[]): IResult<PlannedRefund> {
    const settlement = this.findSettlement(settlementId);
    if (!settlement)
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found', { id: settlementId.value }));
    if (settlement.payee.value !== caller.value) return Result.fail(new OnlyThePayeeMayRefund());
    if (settlement.method === 'cash' || !settlement.provider) return Result.fail(new CashIsNotRefunded());
    if (settlement.status !== 'paid') return Result.fail(new OnlyAPaidSettlementIsRefunded());
    if (!members.includes(settlement.payer.value)) return Result.fail(new PayerNotAMember());
    if (!members.includes(settlement.payee.value)) return Result.fail(new PayeeNotAMember());

    return Result.ok({ settlementId: settlement.id.value, paymentId: settlement.provider.paymentId });
  }

  /**
   * Second half of a refund: the rules are decided again, on the members read after the provider answered, and the settlement is
   * refunding (it still counts, the money is not back). A refusal by the provider (`accepted` false) changes nothing.
   */
  recordRefund(settlementId: Id, caller: Id, members: string[], accepted: boolean): IResult<Settlement> {
    const decided = this.decideRefund(settlementId, caller, members);
    if (decided.isFailure()) return decided;
    if (!accepted) return Result.fail(new ProviderRefundUnavailable());

    const settlement = this.findSettlement(settlementId) as Settlement;
    settlement.startRefund();
    this.statusChanged.push(settlement);
    this.record(
      RefundRequestedEvent.set({
        settlementId: settlement.id.value,
        groupId: this.groupId.value,
        payer: settlement.payer.value,
        payee: settlement.payee.value,
        amount: settlement.amount,
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * The rules a settlement is decided by, on what is owed now: the balances as Ledger counts them, less what is waiting at the
   * provider (a waiting payment from the payer lowers what they owe; one to the payee lowers what they are owed).
   */
  private decide(decision: Decision): IResult<void> {
    const { payer, payee, amount, payerIsMember, payeeIsMember, payerBalance, payeeBalance } = decision;
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmount());
    if (!payerIsMember) return Result.fail(new PayerNotAMember());
    if (!payeeIsMember) return Result.fail(new PayeeNotAMember());
    if (payer.value === payee.value) return Result.fail(new PaidToSelf());
    if (amount > Math.max(0, -(payerBalance + this.waitingEffectOn(payer))))
      return Result.fail(new ExceedsWhatIsOwed());
    if (amount > Math.max(0, payeeBalance + this.waitingEffectOn(payee)))
      return Result.fail(new ExceedsWhatIsOwedToPayee());
    return Result.ok();
  }

  /** What the payments waiting at the provider do to a member's balance: up for a payer, down for a payee. */
  private waitingEffectOn(member: Id): number {
    return this.waiting.reduce(
      (sum, settlement) =>
        sum +
        (settlement.payer.value === member.value ? settlement.amount : 0) -
        (settlement.payee.value === member.value ? settlement.amount : 0),
      0,
    );
  }

  private findSettlement(settlementId: Id): Settlement | undefined {
    return this.settlements.find(settlement => settlement.id.value === settlementId.value);
  }

  /** A settlement recorded in this book is kept with the ones read, so that it is found by what follows in the same transaction. */
  private keep(settlement: Settlement): void {
    this.made.push(settlement);
    this.settlements.push(settlement);
  }
}

/** The outcome a provider's webhook status names for a payment, or `null` for a status Tally does not know or waits on. */
const outcomeOf = (status: string): PaymentOutcome | null => {
  if (status === 'succeeded') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'refunded') return 'refunded';
  return null;
};

/**
 * Whether a payment may move from its status to an outcome. A payment moves forward: a pending one is paid or failed, and any one
 * that is paid, or being refunded, is refunded, last of all (request 14, request 15). Nothing moves back, and nothing moves out of
 * failed or refunded.
 */
const movesTo = (from: Settlement['status'], to: PaymentOutcome): boolean => {
  if (to === 'refunded') return from === 'pending' || from === 'paid' || from === 'refunding';
  return from === 'pending';
};
