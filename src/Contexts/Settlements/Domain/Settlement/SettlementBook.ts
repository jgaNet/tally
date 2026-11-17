import { AggregateRoot, IResult, Id, Result } from '@Architecture/Domain';

import {
  ISettlementBookSnapshot,
  ISettlementSnapshot,
  PaymentLink,
} from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  InvalidSettlementAmountException,
  ProviderUnavailableException,
  SettlementExceedsBalanceException,
  SettlementPayerNotMemberException,
  SettlementToSelfException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  PaymentRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';

/** A balance as the decision reads it: the member's balance in the group, positive when owed, negative when owing. */
export interface BalanceOfMember {
  memberId: string;
  balance: number;
}

/** A settlement the decision is asked for: who pays whom, how much, when, against the group's members and balances. */
export interface SettlementRequest {
  payer: string;
  payee: string;
  amount: number;
  at: Date;
  members: string[];
  balances: BalanceOfMember[];
}

/** What the provider says of a payment in a webhook: `pending`, `succeeded` or `failed`; any other word changes nothing. */
export interface ProviderPaymentUpdate {
  paymentId: string;
  status: string;
}

/**
 * A payment through the provider decided, but not yet kept: the settlement's id, which is the reference the provider is asked
 * with, and the request it was decided on. Nothing is recorded until `keepPayment()` takes the provider's link.
 */
export interface PaymentProposal {
  readonly settlementId: string;
  readonly request: SettlementRequest;
}

/**
 * SettlementBook is the aggregate root of the settlements of one group, the one place they are decided in, so that two
 * settlements decided at once cannot pay more than is owed (request 12 and 13, the storms `settle-in-cash` and
 * `pay-through-the-provider`, ADR 8).
 *
 * A settlement is one transfer from a payer to a payee of the group, paid in cash or through the payment provider. It is
 * decided against the balances as they are when it is decided, which the handler reads through the port Settlements owns
 * (`IGroupBalances`) in the same transaction as the book's version, and against what is still owed: a payment waiting at the
 * provider counts as if it were paid, so what a member still owes is what they owe, less what they are waiting to pay, and
 * what a member is still owed is what they are owed, less what is waiting to be paid to them. A settlement's amount is a whole
 * number of at least 1, the payer is a member other than the payee, and the amount is at most what the payer still owes and
 * at most what the payee is still owed. Otherwise it is refused, and the book does not change.
 *
 * A settlement through the provider is decided in two steps, so that the provider is asked only for a payment the rules allow:
 * `proposePayment()` decides it and names it; once the provider has answered a link, `keepPayment()` decides it again with the
 * link in hand and keeps it, pending. A settlement that is never kept is never paid. The provider's webhook reaches the book
 * through `receiveProviderUpdate()`: a pending payment becomes paid or failed, once; any other webhook changes nothing.
 *
 * The book's version is the check (CONC-OPTIMISTIC): a save is refused when another writer saved first, and the command
 * handler re-reads the book and the balances and decides again. The book records what it decides and publishes nothing itself.
 */
export class SettlementBook extends AggregateRoot {
  readonly #groupId: string;
  /** Every settlement of the group the book knows: those it read, and those it decided since. */
  readonly #settlements = new Map<string, ISettlementSnapshot>();
  /** The ids of the settlements decided since the book was read, in the order they were decided. */
  readonly #recorded: string[] = [];
  /** The ids of the settlements read by the book whose status it moved since. */
  readonly #changed = new Set<string>();

  private constructor(id: Id, groupId: string, version: number, settlements: ISettlementSnapshot[]) {
    super(id, version);
    this.#groupId = groupId;
    for (const settlement of settlements) this.#settlements.set(settlement._id, { ...settlement });
  }

  /** The book of a group that has no settlement yet: at version 0, with the identity the domain generates. Records nothing. */
  static open(groupId: string): SettlementBook {
    return new SettlementBook(Id.generate(), groupId, 0, []);
  }

  /** The book as the store holds it, at the version it was read at, with the settlements of its group. Records nothing. */
  static fromSnapshot({
    _id,
    groupId,
    version,
    settlements,
  }: {
    _id: string;
    groupId: string;
    version: number;
    settlements: ISettlementSnapshot[];
  }): SettlementBook {
    return new SettlementBook(new Id(_id), groupId, version, settlements);
  }

  /**
   * Records a settlement that `payer` paid `payee` in cash, of `amount`, decided against the request's balances and what is
   * still owed. It is paid at once, and records `SettlementRecorded`; a refused settlement records nothing and changes nothing.
   */
  recordCash(request: SettlementRequest): IResult<ISettlementSnapshot> {
    const decided = this.decide(request);
    if (decided.isFailure()) return Result.fail(decided.error);

    const settlement = this.keep({
      _id: Id.generate().value,
      from: request.payer,
      to: request.payee,
      amount: request.amount,
      at: request.at,
      method: 'cash',
      status: 'paid',
      providerPaymentId: null,
      payUrl: null,
    });
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement._id,
        groupId: this.#groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
      }),
    );
    return Result.ok({ ...settlement });
  }

  /**
   * Decides a payment through the provider, before the provider is asked: the rules of `recordCash()`, against what is still
   * owed, and the settlement's id the provider is asked with as the reference. Records nothing.
   */
  proposePayment(request: SettlementRequest): IResult<PaymentProposal> {
    const decided = this.decide(request);
    if (decided.isFailure()) return Result.fail(decided.error);
    return Result.ok({ settlementId: Id.generate().value, request: { ...request } });
  }

  /**
   * Keeps a proposed payment with the provider's link, pending, and records `PaymentRequested`. The rules are decided again with
   * the link in hand; a link that is missing or not a link is refused as ProviderUnavailable, and nothing is kept.
   */
  keepPayment(proposal: PaymentProposal, link: PaymentLink | null): IResult<ISettlementSnapshot> {
    if (!isLink(link)) return Result.fail(new ProviderUnavailableException());
    const decided = this.decide(proposal.request);
    if (decided.isFailure()) return Result.fail(decided.error);

    const { request } = proposal;
    const settlement = this.keep({
      _id: proposal.settlementId,
      from: request.payer,
      to: request.payee,
      amount: request.amount,
      at: request.at,
      method: 'provider',
      status: 'pending',
      providerPaymentId: link.id,
      payUrl: link.payUrl,
    });
    this.record(
      PaymentRequestedEvent.set({
        settlementId: settlement._id,
        groupId: this.#groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
      }),
    );
    return Result.ok({ ...settlement });
  }

  /**
   * Takes the provider's word on a payment of this book: a pending payment becomes paid when the provider says it succeeded, and
   * failed when it says it failed, each once. A payment that already ended, a status that is `pending` or unknown, and a payment
   * this book does not hold change nothing; the answer is a success either way, as the provider needs.
   */
  receiveProviderUpdate({ paymentId, status }: ProviderPaymentUpdate): IResult<void> {
    const settlement = [...this.#settlements.values()].find(
      ({ method, providerPaymentId }) => method === 'provider' && providerPaymentId === paymentId,
    );
    if (!settlement || settlement.status !== 'pending') return Result.ok();

    const facts = {
      settlementId: settlement._id,
      groupId: this.#groupId,
      from: settlement.from,
      to: settlement.to,
      amount: settlement.amount,
    };
    if (status === 'succeeded') {
      this.#moveStatus(settlement, 'paid');
      this.record(SettlementPaidEvent.set(facts));
    } else if (status === 'failed') {
      this.#moveStatus(settlement, 'failed');
      this.record(SettlementFailedEvent.set(facts));
    }
    return Result.ok();
  }

  /** Whether the book moved since it was read: a settlement decided, or a status the provider moved. */
  hasChanges(): boolean {
    return this.#recorded.length > 0 || this.#changed.size > 0;
  }

  /** The book as the store writes it: what was decided or moved since it was read, with the version it was read at. */
  toSnapshot(): ISettlementBookSnapshot {
    const recordedIds = new Set(this.#recorded);
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      version: this.version,
      recorded: this.#recorded.map(id => ({ ...this.#settlements.get(id)! })),
      changed: [...this.#changed].filter(id => !recordedIds.has(id)).map(id => ({ ...this.#settlements.get(id)! })),
    };
  }

  /** The rules of a settlement, decided against the request's balances and what is still owed. Records nothing. */
  private decide({ payer, payee, amount, members, balances }: SettlementRequest): IResult<void> {
    if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());
    if (payer === payee) return Result.fail(new SettlementToSelfException());
    if (!members.includes(payer)) return Result.fail(new SettlementPayerNotMemberException());

    const balanceOf = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
    const owedByPayer = Math.max(0, -(balanceOf.get(payer) ?? 0) - this.#waitingFrom(payer));
    const owedToPayee = Math.max(0, (balanceOf.get(payee) ?? 0) - this.#waitingTo(payee));
    if (amount > owedByPayer || amount > owedToPayee) return Result.fail(new SettlementExceedsBalanceException());
    return Result.ok();
  }

  /** What `payer` is still to pay through the provider: the payments waiting, which count as paid. */
  #waitingFrom(member: string): number {
    return this.#sumPending(settlement => settlement.from === member);
  }

  /** What `payee` is still to be paid through the provider: the payments waiting, which count as paid. */
  #waitingTo(member: string): number {
    return this.#sumPending(settlement => settlement.to === member);
  }

  #sumPending(matches: (settlement: ISettlementSnapshot) => boolean): number {
    let total = 0;
    for (const settlement of this.#settlements.values()) {
      if (settlement.method === 'provider' && settlement.status === 'pending' && matches(settlement)) {
        total += settlement.amount;
      }
    }
    return total;
  }

  private keep(settlement: Omit<ISettlementSnapshot, 'groupId' | 'at'> & { at: Date }): ISettlementSnapshot {
    const kept: ISettlementSnapshot = {
      _id: settlement._id,
      groupId: this.#groupId,
      from: settlement.from,
      to: settlement.to,
      amount: settlement.amount,
      at: settlement.at.toISOString(),
      method: settlement.method,
      status: settlement.status,
      providerPaymentId: settlement.providerPaymentId,
      payUrl: settlement.payUrl,
    };
    this.#settlements.set(kept._id, kept);
    this.#recorded.push(kept._id);
    return kept;
  }

  #moveStatus(settlement: ISettlementSnapshot, status: ISettlementSnapshot['status']): void {
    settlement.status = status;
    this.#changed.add(settlement._id);
  }
}

function isLink(link: PaymentLink | null): link is PaymentLink {
  return (
    link !== null &&
    typeof link.id === 'string' &&
    link.id.length > 0 &&
    typeof link.payUrl === 'string' &&
    link.payUrl.length > 0
  );
}
