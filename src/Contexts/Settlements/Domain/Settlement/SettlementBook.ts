import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import {
  ExceedsWhatIsOwed,
  ExceedsWhatIsOwedToPayee,
  InvalidSettlementAmount,
  PaidToSelf,
  PayeeNotAMember,
  PayerNotAMember,
  ProviderUnavailable,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  PaymentRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';

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

/** The payment link the provider gave for a payment: its id at the provider, and the link the payer pays at. */
export interface PaymentLink {
  readonly paymentId: string;
  readonly payUrl: string;
}

/**
 * The one place every settlement of a group is decided in (the storm's T7): a book per group, with a version, so that two writers
 * who read the same book cannot both win (CONC-OPTIMISTIC). A settlement is decided against the balances the handler reads inside
 * its transaction, and against what is waiting at the provider: it never pays more than the payer still owes, nor more than the
 * payee is still owed, at the moment it is recorded. The book holds the group's payments waiting at the provider, and the
 * settlements and status changes recorded in it since it was read; the repository stores them with its version.
 */
export class SettlementBook extends AggregateRoot {
  private readonly made: Settlement[] = [];
  private readonly statusChanged: Settlement[] = [];

  private constructor(
    id: Id,
    readonly groupId: Id,
    version: number,
    /** The settlements of the group whose status is pending, as read, and those recorded since. */
    private readonly waiting: Settlement[],
  ) {
    super(id, version);
  }

  /** The book of a group that has no settlement yet: it is opened by its first settlement, at version 0. */
  static open(groupId: Id): SettlementBook {
    return new SettlementBook(Id.generate(), groupId, 0, []);
  }

  /** The book as it is kept, at the version it was read at, with the payments waiting in it; it records nothing. */
  static fromSnapshot({
    id,
    groupId,
    version,
    waiting,
  }: {
    id: string;
    groupId: string;
    version: number;
    waiting: Settlement[];
  }): SettlementBook {
    return new SettlementBook(new Id(id), new Id(groupId), version, [...waiting]);
  }

  /** The settlements recorded in this book since it was read, in the order they were recorded. */
  get created(): readonly Settlement[] {
    return this.made;
  }

  /** The settlements whose status changed since the book was read: the provider said how their payment ended. */
  get statusChangedSinceRead(): readonly Settlement[] {
    return this.statusChanged;
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
    this.made.push(settlement);
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
    this.made.push(settlement);
    this.waiting.push(settlement);
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
   * The provider's webhook about one of the book's payments: a payment that succeeded is paid, one that failed is failed. A payment
   * Tally does not know, one not waiting any more, a status still pending, or a status it does not know, changes nothing; so does a
   * webhook that comes twice or out of order. Returns whether anything changed.
   */
  receivePayment(paymentId: string, status: string): boolean {
    const settlement = this.waiting.find(
      waiting => waiting.status === 'pending' && waiting.provider?.paymentId === paymentId,
    );
    if (!settlement) return false;

    const outcome = status === 'succeeded' ? 'paid' : status === 'failed' ? 'failed' : null;
    if (!outcome) return false;

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
    else this.record(SettlementFailedEvent.set(payload));
    return true;
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
    return this.waiting
      .filter(settlement => settlement.status === 'pending')
      .reduce(
        (sum, settlement) =>
          sum +
          (settlement.payer.value === member.value ? settlement.amount : 0) -
          (settlement.payee.value === member.value ? settlement.amount : 0),
        0,
      );
  }
}
