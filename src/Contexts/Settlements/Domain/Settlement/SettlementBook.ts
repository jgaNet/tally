import { AggregateRoot, DomainEvent, Exception, Id, IResult, Result } from '@Architecture/Domain';

import {
  GroupNotFoundException,
  InvalidSettlementAmountException,
  MoreThanPayeeIsOwedException,
  MoreThanPayerOwesException,
  PayeeIsPayerException,
  PayerNotInGroupException,
  ProviderUnavailableException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { ProviderPayment, Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { MemberBalance } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/** A settlement the payee records in cash, or a payer asks to pay through the provider: who pays whom, and how much. */
export interface SettlementDraft {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/** A payment waiting at the provider: pending, so counted as paid for what is still owed (request 13). */
export interface WaitingPayment {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * A payment proposed, before the provider is asked for its link: the settlement's identity, which is the reference the provider is
 * given, and when it was decided. Nothing is kept until the book records it with the link (`recordPayment`).
 */
export interface PaymentProposal extends SettlementDraft {
  readonly id: string;
  readonly at: string;
}

export type SettlementRecordedPayload = {
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  at: string;
};

/** A settlement was recorded in cash: the balances count it from now on, and nothing reacts to it yet. */
export class SettlementRecordedEvent extends DomainEvent<SettlementRecordedPayload> {}

export type PaymentRequestedPayload = SettlementRecordedPayload;

/** A payment through the provider was requested: pending, counted as paid for what is still owed, and not yet in the balances. */
export class PaymentRequestedEvent extends DomainEvent<PaymentRequestedPayload> {}

export type PaymentEndedPayload = Omit<SettlementRecordedPayload, 'at'>;

/** A payment the provider said succeeded: from now on the balances count it, as a settlement in cash. */
export class SettlementPaidEvent extends DomainEvent<PaymentEndedPayload> {}

/** A payment the provider said failed: never counted, and no longer waiting. */
export class SettlementFailedEvent extends DomainEvent<PaymentEndedPayload> {}

/** What a group's book is opened with: the group, the version it was read at, its members in join order, and their balances. */
export interface SettlementBookSnapshot {
  readonly groupId: string;
  readonly version: number;
  readonly members: readonly string[];
  /** What the ledger counts: the balances of the settlements already paid, and of the expenses. */
  readonly balances: readonly MemberBalance[];
  /** The payments waiting at the provider, which the book counts as paid for what is still owed (none when omitted). */
  readonly waiting?: readonly WaitingPayment[];
}

/**
 * The book of a group's settlements (conventions/domain.yaml, ADR 10, the storm's `SettlementBook`): the one aggregate every
 * settlement of the group is decided in, in cash and through the provider alike. It is opened with the members in the order they
 * joined, the balances as the ledger counts them, and the payments waiting at the provider, so a settlement is decided against
 * what is still owed at the moment it is decided. It carries the version it was read at and never changes it: the store saves it
 * at that version, or refuses it (CONC-OPTIMISTIC), so of two settlements decided at once, the second is decided again on the
 * first one's balances.
 */
export class SettlementBook extends AggregateRoot {
  readonly #members: readonly string[];
  readonly #balances: readonly MemberBalance[];
  readonly #waiting: readonly WaitingPayment[];

  private constructor(
    id: Id,
    version: number,
    members: readonly string[],
    balances: readonly MemberBalance[],
    waiting: readonly WaitingPayment[],
  ) {
    super(id, version);
    this.#members = members;
    this.#balances = balances;
    this.#waiting = waiting;
  }

  /** The group this book is the book of. */
  get groupId(): string {
    return this._id.value;
  }

  /** Opens the book as it was read. Records nothing: a book is read, not created (feature 12). */
  static open({ groupId, version, members, balances, waiting = [] }: SettlementBookSnapshot): SettlementBook {
    return new SettlementBook(
      new Id(groupId),
      version,
      [...members],
      balances.map(row => ({ ...row })),
      waiting.map(payment => ({ ...payment })),
    );
  }

  /** Whether the account is a member of the group now. */
  hasMember(memberId: string): boolean {
    return this.#members.includes(memberId);
  }

  /**
   * What the member still owes (negative) or is still owed (positive) in the group, in hundredths: what the ledger counts, with the
   * payments waiting at the provider counted as paid (request 13). A member nothing has counted is 0.
   */
  balanceOf(memberId: string): number {
    const counted = this.#balances.find(row => row.memberId === memberId)?.balance ?? 0;
    return this.#waiting.reduce(
      (balance, payment) =>
        balance + (payment.from === memberId ? payment.amount : 0) - (payment.to === memberId ? payment.amount : 0),
      counted,
    );
  }

  /** What every member of the group still owes or is still owed, in the order they joined: what the suggestions are made of. */
  stillOwed(): MemberBalance[] {
    return this.#members.map(memberId => ({ memberId, balance: this.balanceOf(memberId) }));
  }

  /**
   * Records a settlement in cash, decided by its payee (request 12). Refused, and nothing recorded, unless the rules of
   * `#refusalOf` hold. Otherwise it is recorded as paid, with its identity generated here (DOMAIN-IDENTITY), and
   * SettlementRecorded is recorded with it. The time is `now`.
   */
  recordCash(draft: SettlementDraft, now: Date): IResult<Settlement> {
    const refusal = this.#refusalOf(draft);
    if (refusal) return Result.fail(refusal);

    const settlement: Settlement = {
      id: Id.generate().value,
      groupId: this.groupId,
      from: draft.from,
      to: draft.to,
      amount: draft.amount,
      method: 'cash',
      status: 'paid',
      at: now.toISOString(),
    };
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id,
        groupId: settlement.groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
        at: settlement.at,
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * The first step of a payment through the provider (request 13): the same rules as in cash, checked against the book as it was
   * opened, and the settlement's identity generated (it is the reference the provider is given). Nothing is recorded: the provider
   * is asked only once the rules hold, and `recordPayment` keeps the payment with the link it answers.
   */
  proposePayment(draft: SettlementDraft, now: Date): IResult<PaymentProposal> {
    const refusal = this.#refusalOf(draft);
    if (refusal) return Result.fail(refusal);
    return Result.ok({ id: Id.generate().value, ...draft, at: now.toISOString() });
  }

  /**
   * The second step, with the provider's answer: the rules are decided again on the same book with the link in hand, and a
   * payment the provider gave no link for (`undefined`, or one without its id or its link) is refused and kept nowhere. Otherwise
   * the settlement is kept pending, with the provider's payment, and PaymentRequested is recorded. Its status is `pending`: it
   * counts for what is still owed, and not in the balances, until the provider says it succeeded.
   */
  recordPayment(proposal: PaymentProposal, link: ProviderPayment | undefined): IResult<Settlement> {
    const refusal = this.#refusalOf(proposal);
    if (refusal) return Result.fail(refusal);
    if (!link?.id || !link.payUrl) return Result.fail(new ProviderUnavailableException());

    const settlement: Settlement = {
      id: proposal.id,
      groupId: this.groupId,
      from: proposal.from,
      to: proposal.to,
      amount: proposal.amount,
      method: 'provider',
      status: 'pending',
      at: proposal.at,
      payment: { id: link.id, payUrl: link.payUrl },
    };
    this.record(
      PaymentRequestedEvent.set({
        settlementId: settlement.id,
        groupId: settlement.groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
        at: settlement.at,
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * The provider's verdict on a payment of this book (request 13): a pending payment that `succeeded` is paid, one that `failed` is
   * failed, and anything else (a verdict that is still `pending`, one the provider has not named, or a payment that already ended)
   * changes nothing and answers `undefined`. A payment ends once. Returns the settlement as it now stands when it changed.
   */
  receive(settlement: Settlement, verdict: string): Settlement | undefined {
    if (settlement.status !== 'pending') return undefined;
    const ended: PaymentEndedPayload = {
      settlementId: settlement.id,
      groupId: settlement.groupId,
      from: settlement.from,
      to: settlement.to,
      amount: settlement.amount,
    };
    if (verdict === 'succeeded') {
      this.record(SettlementPaidEvent.set(ended));
      return { ...settlement, status: 'paid' };
    }
    if (verdict === 'failed') {
      this.record(SettlementFailedEvent.set(ended));
      return { ...settlement, status: 'failed' };
    }
    return undefined;
  }

  /**
   * The refusal of a settlement between two members, or `undefined` when it holds: the payee is a member of the group (else the
   * group's `404`), the amount is a whole number of 1 or more, the payer is a member and not the payee, the amount is no more than
   * the payer still owes, and no more than the payee is still owed.
   */
  #refusalOf({ from, to, amount }: SettlementDraft): Exception | undefined {
    if (!this.hasMember(to)) return new GroupNotFoundException();
    if (!Number.isInteger(amount) || amount < 1) return new InvalidSettlementAmountException();
    if (from === to) return new PayeeIsPayerException();
    if (!this.hasMember(from)) return new PayerNotInGroupException();
    if (amount > -this.balanceOf(from)) return new MoreThanPayerOwesException();
    if (amount > this.balanceOf(to)) return new MoreThanPayeeIsOwedException();
    return undefined;
  }
}
