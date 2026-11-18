import { GroupArchived } from '@SharedKernel/Domain';
import { SettlementBookMergedEvent } from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import {
  CashIsNotRefunded,
  ExceedsWhatIsOwed,
  ExceedsWhatIsOwedToPayee,
  InvalidSettlementAmount,
  OnlyAContestedSettlementIsDecided,
  OnlyAPaidSettlementIsContested,
  OnlyAPaidSettlementIsRefunded,
  OnlyAProviderSettlementIsContested,
  OnlyThePayeeMayContest,
  OnlyThePayeeMayRefund,
  SettlementAlreadyContested,
  PaidToSelf,
  PayeeHasNoPayoutAccount,
  PayeeNotAMember,
  PayerNotAMember,
  ProviderRefundUnavailable,
  ProviderUnavailable,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementAnnulledEvent,
  SettlementContestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import { PaymentOutcome, Settlement, SettlementLine } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * A line of a settlement's history that Tally learned in this book, and where it stands in that history (its position, from 1): the
 * repository stores it in the same transaction as the change it records.
 */
export interface LearnedLine extends SettlementLine {
  readonly settlementId: Id;
  readonly position: number;
}

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
  /** Whether the group is archived, read by the handler: an archived group takes no settlement (request 27). */
  archived: boolean;
}

/**
 * A payment through the provider, decided and named, not yet recorded: its id is the reference the provider is given, and
 * `payeeAccount` is the payee's payout account at the provider, the account the payment is made to (request 16).
 */
export interface PlannedPayment {
  readonly id: Id;
  readonly groupId: Id;
  readonly payer: Id;
  readonly payee: Id;
  readonly amount: number;
  readonly at: Date;
  readonly payeeAccount: string;
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
 * A change of money the book made since it was read: a settlement the balances start to count (`settlement-paid`, by its payee
 * when it is in cash, by its payer when the provider says it succeeded), or stop counting (`settlement-refunded`, by its payee,
 * when the provider says it is refunded, and only if it was counted before). Audited by the handler, in its transaction (request 28).
 */
export interface MoneyMoved {
  action: 'settlement-paid' | 'settlement-refunded' | 'settlement-contested';
  by: Id;
  settlement: Settlement;
}

/** A decision an administrator made about a contested settlement, kept in the administrators' log (request 33). */
export interface AdministratorDecided {
  readonly action: 'decided-paid' | 'decided-annulled';
  readonly by: Id;
  readonly settlement: Settlement;
}

/**
 * The id an audit entry is kept under: the change's action and its settlement, and the place the change holds in the settlement's history,
 * so that a settlement paid by the provider and then paid again by an administrator is audited twice (request 33).
 */
export const auditIdOf = (move: MoneyMoved): string =>
  `${move.action}:${move.settlement.id.value}:${move.settlement.history.length}`;

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
  private readonly moneyMoved: MoneyMoved[] = [];
  private readonly decisions: AdministratorDecided[] = [];
  /** The lines learned on settlements that were read (a settlement recorded here keeps its lines in `made`). */
  private readonly learned: LearnedLine[] = [];

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

  /** The group whose book was merged into this one (request 31), or null: its settlements are this book's once it is saved. */
  private mergedFrom: Id | null = null;

  get absorbedFrom(): Id | null {
    return this.mergedFrom;
  }

  /**
   * The book of the group merged into this group's (request 31) is taken up: its settlements and their audit are this group's when the book
   * is saved, and the merged book is gone with them. Recorded as SettlementBookMerged, once.
   */
  absorb(mergedGroupId: Id): IResult {
    if (this.mergedFrom) return Result.fail(new NotFoundException('Settlements', 'The book was merged already'));
    this.mergedFrom = mergedGroupId;
    this.record(SettlementBookMergedEvent.set({ groupId: this.groupId.value, mergedGroupId: mergedGroupId.value }));
    return Result.ok();
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

  /**
   * Every line of history this book learned since it was read: the first line of each settlement recorded here, then the lines
   * learned on the settlements that were read, in the order they were learned.
   */
  get learnedSinceRead(): readonly LearnedLine[] {
    const recorded = this.made.flatMap(settlement =>
      settlement.history.map((line, index) => ({
        settlementId: settlement.id,
        position: index + 1,
        status: line.status,
        at: line.at,
      })),
    );
    return [...recorded, ...this.learned];
  }

  /** The changes of money the book made since it was read, in the order they were made (request 28). */
  get moneyMovedSinceRead(): readonly MoneyMoved[] {
    return this.moneyMoved;
  }

  /** The decisions administrators made about contested settlements since the book was read, in the order they were made (request 33). */
  get administratorDecisionsSinceRead(): readonly AdministratorDecided[] {
    return this.decisions;
  }

  /** The settlements of the group whose payment is waiting at the provider, or held by a contest until an administrator decides (request 33). */
  private get waiting(): Settlement[] {
    return this.settlements.filter(settlement => settlement.status === 'pending' || settlement.status === 'contested');
  }

  /**
   * Records a payment in cash from `payer` to `payee`, decided on the balances as they are now. `now` is the application's clock,
   * read by the handler: the settlement's time is a parameter, never a default.
   */
  recordCash({ now, ...decision }: Decision & { now: Date }): IResult<Settlement> {
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;

    const settlement = paidAtOnce(this.groupId, 'cash', decision, now);
    this.keep(settlement);
    this.moneyMoved.push({ action: 'settlement-paid', by: decision.payee, settlement });
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
   * Records one settlement of a netting (request 32), in this group: `payer` pays `payee` the amount, by `net`, paid at once, so it
   * counts at once; it is audited as paid by `by`, the member who asked for the netting. The netting decided the amount on the balances
   * read in this transaction, and this checks it again on the same rules as a cash settlement.
   */
  recordNet({ by, now, ...decision }: Decision & { by: Id; now: Date }): IResult<Settlement> {
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;

    const settlement = paidAtOnce(this.groupId, 'net', decision, now);
    this.keep(settlement);
    this.moneyMoved.push({ action: 'settlement-paid', by, settlement });
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
   * A member's balance as the rules count it: the balance Ledger keeps, with what waits at the provider counted as paid (up for a
   * payer, down for a payee). The netting decides on this, so that its amounts are the ones the book would accept.
   */
  effectiveBalance(member: Id, ledgerBalance: number): number {
    return ledgerBalance + this.waitingEffectOn(member);
  }

  /**
   * First half of a payment through the provider: the rules decided now, and the id the payment is kept under, which the provider
   * is given as its reference. A payee with no payout account (`payeeAccount` null) is refused here, before the provider is asked
   * (request 16). Nothing is recorded: when the provider gives no link, nothing was kept.
   */
  planPayment({
    now,
    payeeAccount,
    ...decision
  }: Decision & { now: Date; payeeAccount: string | null }): IResult<PlannedPayment> {
    const decided = this.decide(decision);
    if (decided.isFailure()) return decided;
    if (payeeAccount === null) return Result.fail(new PayeeHasNoPayoutAccount());

    return Result.ok({
      id: Id.generate(),
      groupId: this.groupId,
      payer: decision.payer,
      payee: decision.payee,
      amount: decision.amount,
      at: now,
      payeeAccount,
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
      [{ status: 'pending', at: planned.at }],
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
   * whether anything changed. `now` is when Tally learned the status: the clock the handler reads, never a default.
   */
  receivePayment(paymentId: string, status: string, now: Date): boolean {
    const settlement = this.settlements.find(known => known.provider?.paymentId === paymentId);
    if (!settlement) return false;

    const outcome = outcomeOf(status);
    if (!outcome || !movesTo(settlement.status, outcome)) return false;

    const before = settlement.status;
    this.learn(settlement, settlement.end(outcome, now));
    this.statusChanged.push(settlement);
    if (outcome === 'paid') this.moneyMoved.push({ action: 'settlement-paid', by: settlement.payer, settlement });
    if (outcome === 'refunded' && (before === 'paid' || before === 'refunding')) {
      this.moneyMoved.push({ action: 'settlement-refunded', by: settlement.payee, settlement });
    }
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
  decideRefund(settlementId: Id, caller: Id, members: string[], archived: boolean): IResult<PlannedRefund> {
    if (archived) return Result.fail(new GroupArchived('Settlements'));
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
   * refunding (it still counts, the money is not back). A refusal by the provider (`accepted` false) changes nothing. `now` is when
   * Tally learned the provider accepted the refund.
   */
  recordRefund(
    settlementId: Id,
    caller: Id,
    members: string[],
    accepted: boolean,
    now: Date,
    archived: boolean,
  ): IResult<Settlement> {
    const decided = this.decideRefund(settlementId, caller, members, archived);
    if (decided.isFailure()) return decided;
    if (!accepted) return Result.fail(new ProviderRefundUnavailable());

    const settlement = this.findSettlement(settlementId) as Settlement;
    this.learn(settlement, settlement.startRefund(now));
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
   * The payee of a settlement paid through the provider says the money did not reach them (request 33): the settlement is contested, and
   * it waits, held, until an administrator decides. Only its payee contests it, only through the provider, only once, only while it is paid,
   * and only while its payer and its payee are members of the group; the group is not archived. `now` is when Tally learned it, the clock's.
   */
  contest({
    settlementId,
    caller,
    members,
    archived,
    now,
  }: {
    settlementId: Id;
    caller: Id;
    members: string[];
    archived: boolean;
    now: Date;
  }): IResult {
    if (archived) return Result.fail(new GroupArchived('Settlements'));
    const settlement = this.findSettlement(settlementId);
    if (!settlement)
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found', { id: settlementId.value }));
    if (settlement.payee.value !== caller.value) return Result.fail(new OnlyThePayeeMayContest());
    if (settlement.method !== 'provider') return Result.fail(new OnlyAProviderSettlementIsContested());
    if (settlement.history.some(line => line.status === 'contested'))
      return Result.fail(new SettlementAlreadyContested());
    if (settlement.status !== 'paid') return Result.fail(new OnlyAPaidSettlementIsContested());
    if (!members.includes(settlement.payer.value)) return Result.fail(new PayerNotAMember());
    if (!members.includes(settlement.payee.value)) return Result.fail(new PayeeNotAMember());

    this.learn(settlement, settlement.contest(now));
    this.statusChanged.push(settlement);
    this.moneyMoved.push({ action: 'settlement-contested', by: caller, settlement });
    this.record(SettlementContestedEvent.set(this.payloadOf(settlement)));
    return Result.ok();
  }

  /**
   * An administrator decides a contested settlement (request 33): `paid` when the money arrived, so that it counts as it did before it was
   * contested; otherwise it is annulled, and what was owed is owed again. Only a contested settlement is decided, once.
   */
  decideContest({
    settlementId,
    administrator,
    paid,
    now,
  }: {
    settlementId: Id;
    administrator: Id;
    paid: boolean;
    now: Date;
  }): IResult {
    const settlement = this.findSettlement(settlementId);
    if (!settlement)
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found', { id: settlementId.value }));
    if (settlement.status !== 'contested') return Result.fail(new OnlyAContestedSettlementIsDecided());

    this.learn(settlement, settlement.decide(paid, now));
    this.statusChanged.push(settlement);
    if (paid) {
      this.moneyMoved.push({ action: 'settlement-paid', by: administrator, settlement });
      this.record(SettlementPaidEvent.set(this.payloadOf(settlement)));
    } else {
      this.record(SettlementAnnulledEvent.set(this.payloadOf(settlement)));
    }
    this.decisions.push({
      action: paid ? 'decided-paid' : 'decided-annulled',
      by: administrator,
      settlement,
    });
    return Result.ok();
  }

  private payloadOf(settlement: Settlement) {
    return {
      settlementId: settlement.id.value,
      groupId: this.groupId.value,
      payer: settlement.payer.value,
      payee: settlement.payee.value,
      amount: settlement.amount,
    };
  }

  /**
   * The rules a settlement is decided by, on what is owed now: the balances as Ledger counts them, less what is waiting at the
   * provider (a waiting payment from the payer lowers what they owe; one to the payee lowers what they are owed).
   */
  private decide(decision: Decision): IResult<void> {
    const { payer, payee, amount, payerIsMember, payeeIsMember, payerBalance, payeeBalance, archived } = decision;
    if (archived) return Result.fail(new GroupArchived('Settlements'));
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

  /** A line learned on a settlement that was read: kept for the repository, at its place in the settlement's history. */
  private learn(settlement: Settlement, line: SettlementLine): void {
    this.learned.push({
      settlementId: settlement.id,
      position: settlement.history.length,
      status: line.status,
      at: line.at,
    });
  }
}

/** A settlement paid at once, in cash or by netting: `paid` from the moment it is recorded, and its history starts there. */
const paidAtOnce = (groupId: Id, method: 'cash' | 'net', decision: Decision, now: Date): Settlement =>
  new Settlement(Id.generate(), groupId, decision.payer, decision.payee, decision.amount, method, 'paid', now, null, [
    { status: 'paid', at: now },
  ]);

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
