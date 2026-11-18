import { AggregateRoot, DomainEvent, Exception, Id, IResult, Result } from '@Architecture/Domain';

import { AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';
import { PayeeHasNoPayoutAccountException } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccountExceptions';
import {
  ContestNotPayeeException,
  ContestPartyLeftException,
  GroupNotFoundException,
  InvalidFeeBearerException,
  InvalidSettlementAmountException,
  MoreThanPayeeIsOwedException,
  MoreThanPayerOwesException,
  PayeeIsPayerException,
  PayerNotInGroupException,
  ProviderUnavailableException,
  RefundNotPayeeException,
  RefundPartyLeftException,
  RefundUnavailableException,
  SettlementNotContestableException,
  SettlementNotContestedException,
  SettlementNotRefundableException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  FeeBearer,
  ProviderLink,
  ProviderPayment,
  Settlement,
} from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { MemberBalance } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';
import { OriginalAmount, OriginalDraft } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/**
 * A settlement the payee records in cash, or a payer asks to pay through the provider: who pays whom, and how much. It is given in the
 * group's currency (`amount`, request 12), or in another one (`original`, request 39), whose amount in the group's currency the book
 * decides at the rate offered; `original` wins when both are given (the transport lets only one through).
 */
export interface SettlementDraft {
  readonly from: string;
  readonly to: string;
  readonly amount?: number;
  readonly original?: OriginalDraft;
}

/** A payment waiting at the provider: pending, so counted as paid for what is still owed (request 13). */
export interface WaitingPayment {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * A payment proposed, before the provider is asked for its link: the settlement's identity, which is the reference the provider is
 * given, the provider's id of the payee's payout account the money goes to (request 16), and when it was decided. Nothing is kept
 * until the book records it with the link (`recordPayment`).
 */
export interface PaymentProposal {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The amount in the group's currency's hundredths, which the settlement settles. */
  readonly amount: number;
  /** What was paid in another currency and at which rate, when it is (request 39). */
  readonly original?: OriginalAmount;
  readonly payee: string;
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

export type SettlementBookMergedPayload = {
  groupId: string;
  mergedGroupId: string;
  settlementIds: string[];
  at: string;
};

/**
 * The fact of a merge of books (feature 31, request 31): the settlements of the group merged are the group kept's now, by their ids. Made
 * durable with the move, published after it commits; nothing subscribes to it.
 */
export class SettlementBookMergedEvent extends DomainEvent<SettlementBookMergedPayload> {}

export type PaymentRequestedPayload = SettlementRecordedPayload;

/** A payment through the provider was requested: pending, counted as paid for what is still owed, and not yet in the balances. */
export class PaymentRequestedEvent extends DomainEvent<PaymentRequestedPayload> {}

export type PaymentEndedPayload = Omit<SettlementRecordedPayload, 'at'>;

/** A payment the provider said succeeded: from now on the balances count it, as a settlement in cash. */
export class SettlementPaidEvent extends DomainEvent<PaymentEndedPayload> {}

/** A payment the provider said failed: never counted, and no longer waiting. */
export class SettlementFailedEvent extends DomainEvent<PaymentEndedPayload> {}

/** Tally asked the provider to refund a paid settlement: it is `refunding`, and still counted as paid until the provider says so (request 15). */
export class RefundRequestedEvent extends DomainEvent<PaymentEndedPayload> {}

/** The provider said a payment is refunded: from now on the balances no longer count it, as if it had never been paid (request 15). */
export class SettlementRefundedEvent extends DomainEvent<PaymentEndedPayload> {}

/** The payee contested a paid settlement through the provider: the balances stop counting it, and it waits until an administrator decides (request 33). */
export class SettlementContestedEvent extends DomainEvent<SettlementRecordedPayload> {}

/** An administrator decided a contested settlement was not paid: it is annulled, and what was owed is owed again (request 33). */
export class SettlementAnnulledEvent extends DomainEvent<PaymentEndedPayload> {}

/**
 * Who bears a group's provider fee until its owner decides (request 38): the payee, as they did before fees were borne by anyone.
 */
export const DEFAULT_FEE_BEARER: FeeBearer = 'payee';

/** The fee bearers a group's owner may choose from (request 38). */
export const FEE_BEARERS: readonly FeeBearer[] = ['payer', 'payee', 'shared'];

export type FeePolicySetPayload = {
  groupId: string;
  borneBy: FeeBearer;
  at: string;
};

/** The owner of a group decided who bears its provider's fee from now on: a payment asked for after it is fixed with it (request 38). */
export class FeePolicySetEvent extends DomainEvent<FeePolicySetPayload> {}

/** What a group's book is opened with: the group, the version it was read at, its members in join order, and their balances. */
export interface SettlementBookSnapshot {
  readonly groupId: string;
  /** The currency the group was created in: fixed, and the one every settlement's amount is in (request 2). */
  readonly currency: string;
  readonly version: number;
  readonly members: readonly string[];
  /** What the ledger counts: the balances of the settlements already paid, and of the expenses. */
  readonly balances: readonly MemberBalance[];
  /** The payments waiting at the provider, which the book counts as paid for what is still owed (none when omitted). */
  readonly waiting?: readonly WaitingPayment[];
  /** Who bears the provider's fee of a group's payments, as its owner decided (the payee until then, when omitted). */
  readonly feePolicy?: FeeBearer;
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
  readonly #currency: string;
  readonly #members: readonly string[];
  readonly #balances: readonly MemberBalance[];
  readonly #waiting: readonly WaitingPayment[];
  #feePolicy: FeeBearer;

  private constructor(
    id: Id,
    currency: string,
    version: number,
    members: readonly string[],
    balances: readonly MemberBalance[],
    waiting: readonly WaitingPayment[],
    feePolicy: FeeBearer,
  ) {
    super(id, version);
    this.#currency = currency;
    this.#members = members;
    this.#balances = balances;
    this.#waiting = waiting;
    this.#feePolicy = feePolicy;
  }

  /** The group this book is the book of. */
  get groupId(): string {
    return this._id.value;
  }

  /** The currency of the group: what a settlement's amount is in, and what a settlement in another currency is converted to (request 39). */
  get currency(): string {
    return this.#currency;
  }

  /** Opens the book as it was read. Records nothing: a book is read, not created (feature 12). */
  static open({
    groupId,
    currency,
    version,
    members,
    balances,
    waiting = [],
    feePolicy = DEFAULT_FEE_BEARER,
  }: SettlementBookSnapshot): SettlementBook {
    return new SettlementBook(
      new Id(groupId),
      currency,
      version,
      [...members],
      balances.map(row => ({ ...row })),
      waiting.map(payment => ({ ...payment })),
      feePolicy,
    );
  }

  /** Who bears the group's provider fee now: what a payment asked for from now on is fixed with (request 38). */
  get feePolicy(): FeeBearer {
    return this.#feePolicy;
  }

  /**
   * The owner's decision of who bears the group's provider fee from now on (request 38): the owner is checked by the use case, which reads
   * the roster; the book checks only the bearer it is given, and that the group is not archived. Records FeePolicySet, and the time is
   * `now`. A payment asked for before it keeps the policy it was asked with.
   */
  setFeePolicy(borneBy: string, archived: boolean, now: Date): IResult<FeeBearer> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (!(FEE_BEARERS as readonly string[]).includes(borneBy)) return Result.fail(new InvalidFeeBearerException());
    const bearer = borneBy as FeeBearer;
    this.#feePolicy = bearer;
    this.record(FeePolicySetEvent.set({ groupId: this._id.value, borneBy: bearer, at: now.toISOString() }));
    return Result.ok(bearer);
  }

  /**
   * The book takes in the settlements of the group merged (feature 31, request 31): each keeps its id, its status and its history, and is
   * the group kept's from now on. Records SettlementBookMerged; pure. A merge is decided by the group kept, so the book needs no member
   * or balance for it.
   */
  absorb(mergedGroupId: string, settlementIds: readonly string[], now: Date): void {
    this.record(
      SettlementBookMergedEvent.set({
        groupId: this._id.value,
        mergedGroupId,
        settlementIds: [...settlementIds],
        at: now.toISOString(),
      }),
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
   * SettlementRecorded is recorded with it. The time is `now`. A payee who is suspended (`payeeSuspended`, request 34) records
   * nothing: refused with AccountSuspended, after GroupArchived.
   */
  recordCash(draft: SettlementDraft, archived: boolean, payeeSuspended: boolean, now: Date): IResult<Settlement> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (payeeSuspended) return Result.fail(new AccountSuspendedException());
    const paid = this.#paidIn(draft);
    if (paid.isFailure()) return Result.fail(paid.error);
    const { amount, original } = paid.data;
    const refusal = this.#refusalOf({ from: draft.from, to: draft.to, amount });
    if (refusal) return Result.fail(refusal);

    const settlement: Settlement = {
      id: Id.generate().value,
      groupId: this.groupId,
      from: draft.from,
      to: draft.to,
      amount,
      method: 'cash',
      status: 'paid',
      at: now.toISOString(),
      ...(original && { original: original.toRecord() }),
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
   * Records a settlement that nets two members' debts across their groups (request 32, the storm's NetDebts decision asks it of each
   * group): the same rules as in cash, checked against the book as it was opened, so that no settlement pays more than is still owed.
   * It is recorded as paid, `net`, at once, and SettlementRecorded is recorded with it. The planner never gives an archived group, so
   * this one checks no archive. The time is `now`.
   */
  recordNet(
    draft: { readonly from: string; readonly to: string; readonly amount: number },
    now: Date,
  ): IResult<Settlement> {
    const refusal = this.#refusalOf(draft);
    if (refusal) return Result.fail(refusal);

    const settlement: Settlement = {
      id: Id.generate().value,
      groupId: this.groupId,
      from: draft.from,
      to: draft.to,
      amount: draft.amount,
      method: 'net',
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
   * opened, and then the payee must have a payout account (request 16), read by the use case from its repository: a payee without
   * one is refused by name, before the provider is asked. The settlement's identity is generated (it is the reference the provider is
   * given). Nothing is recorded: the provider is asked only once the rules hold, and `recordPayment` keeps the payment with the link it
   * answers.
   */
  proposePayment(
    draft: SettlementDraft,
    payeeAccount: PayoutAccount | undefined,
    archived: boolean,
    payerSuspended: boolean,
    now: Date,
  ): IResult<PaymentProposal> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (payerSuspended) return Result.fail(new AccountSuspendedException());
    const paid = this.#paidIn(draft);
    if (paid.isFailure()) return Result.fail(paid.error);
    const { amount, original } = paid.data;
    const refusal = this.#refusalOf({ from: draft.from, to: draft.to, amount });
    if (refusal) return Result.fail(refusal);
    if (!payeeAccount) return Result.fail(new PayeeHasNoPayoutAccountException());
    return Result.ok({
      id: Id.generate().value,
      from: draft.from,
      to: draft.to,
      amount,
      ...(original && { original }),
      payee: payeeAccount.providerAccountId,
      at: now.toISOString(),
    });
  }

  /**
   * The second step, with the provider's answer: the rules are decided again on the same book with the link in hand, and a
   * payment the provider gave no link for (`undefined`, or one without its id or its link) is refused and kept nowhere. Otherwise
   * the settlement is kept pending, with the provider's payment, and PaymentRequested is recorded. Its status is `pending`: it
   * counts for what is still owed, and not in the balances, until the provider says it succeeded.
   */
  recordPayment(
    proposal: PaymentProposal,
    link: ProviderLink | undefined,
    archived: boolean,
    payerSuspended: boolean,
  ): IResult<Settlement> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (payerSuspended) return Result.fail(new AccountSuspendedException());
    const refusal = this.#refusalOf(proposal);
    if (refusal) return Result.fail(refusal);
    if (!link?.id || !link.payUrl) return Result.fail(new ProviderUnavailableException());
    // An answer whose fee is not 0 or more, or not less than the amount paid, is no answer (request 38): refused, and nothing kept. A fee
    // in another currency is that currency's, and it is less than the amount in it, then converted at the settlement's rate (request 39).
    const paidFee = link.fee;
    if (!Number.isInteger(paidFee) || paidFee < 0) return Result.fail(new ProviderUnavailableException());
    if (proposal.original && paidFee >= proposal.original.amount)
      return Result.fail(new ProviderUnavailableException());
    const fee = proposal.original ? proposal.original.groupAmountOf(paidFee, this.#currency) : paidFee;
    if (fee >= proposal.amount) return Result.fail(new ProviderUnavailableException());

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
      fee: { amount: fee, borneBy: this.#feePolicy },
      ...(proposal.original && { original: proposal.original.toRecord() }),
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
   * The provider's verdict on a payment of this book (requests 13, 14 and 15). A payment moves forward only, and ends once: a `refunded`
   * verdict takes a payment that is pending (the refund overtook the success), paid or refunding to `refunded`, and a `refunded` already
   * had, or a payment that failed, changes nothing. A pending payment takes `succeeded` to paid, or `failed` to failed. Any other verdict
   * (one the provider has not named, or one still pending) changes nothing and answers `undefined`. Returns the settlement as it now stands
   * when it changed.
   */
  receive(settlement: Settlement, verdict: string, archived: boolean): IResult<Settlement | undefined> {
    const next = endedBy(settlement, verdict);
    if (!next) return Result.ok(undefined);
    if (archived) return Result.fail(new GroupArchivedException());

    const ended: PaymentEndedPayload = {
      settlementId: settlement.id,
      groupId: settlement.groupId,
      from: settlement.from,
      to: settlement.to,
      amount: settlement.amount,
    };
    if (next === 'refunded') this.record(SettlementRefundedEvent.set(ended));
    else if (next === 'paid') this.record(SettlementPaidEvent.set(ended));
    else this.record(SettlementFailedEvent.set(ended));
    return Result.ok({ ...settlement, status: next });
  }

  /**
   * The payee of a settlement paid through the provider contests it (request 33): it is `contested`, held, and counted by what is still owed
   * as a payment waiting at the provider is, but not by the balances, until an administrator decides it. Only its payee contests it (`403`
   * to any other member), once for a settlement, and only while it is `paid` and both its payer and its payee are members of the group
   * (`422`, nothing changes); an archived group changes nothing. Records SettlementContested; the time is `now`, when it is contested.
   */
  contest(settlement: Settlement, payeeId: string, archived: boolean, now: Date): IResult<Settlement> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (settlement.to !== payeeId) return Result.fail(new ContestNotPayeeException());
    if (settlement.method !== 'provider' || settlement.status !== 'paid' || settlement.contestedAt !== undefined) {
      return Result.fail(new SettlementNotContestableException());
    }
    if (!this.hasMember(settlement.from) || !this.hasMember(settlement.to)) {
      return Result.fail(new ContestPartyLeftException());
    }

    const at = now.toISOString();
    this.record(
      SettlementContestedEvent.set({
        settlementId: settlement.id,
        groupId: settlement.groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
        at,
      }),
    );
    return Result.ok({ ...settlement, status: 'contested', contestedAt: at });
  }

  /**
   * An administrator's decision on a contested settlement (request 33): `paid` makes it `paid` again, and the balances count it as they did
   * before it was contested (SettlementPaid); `not paid` annuls it, and what was owed is owed again (SettlementAnnulled). Only a contested
   * settlement is decided, and only once: any other is refused, and nothing changes (`422`). The book is the one it was read from, and the
   * store refuses the save if another writer moved it since.
   */
  decideContest(settlement: Settlement, paid: boolean): IResult<Settlement> {
    if (settlement.status !== 'contested') return Result.fail(new SettlementNotContestedException());

    const ended: PaymentEndedPayload = {
      settlementId: settlement.id,
      groupId: settlement.groupId,
      from: settlement.from,
      to: settlement.to,
      amount: settlement.amount,
    };
    if (paid) {
      this.record(SettlementPaidEvent.set(ended));
      return Result.ok({ ...settlement, status: 'paid' });
    }
    this.record(SettlementAnnulledEvent.set(ended));
    return Result.ok({ ...settlement, status: 'annulled' });
  }

  /**
   * The first step of a refund (request 15): only the payee of a settlement paid through the provider may refund it, and only while it is
   * `paid`, and only while both its payer and its payee are members of the group (so that the balances still add up to 0). Nothing is
   * recorded: the provider is asked for the refund only once these hold, and `recordRefund` keeps its answer. Answers the provider's
   * payment, whose id the provider is asked by.
   */
  proposeRefund(settlement: Settlement, payeeId: string, archived: boolean): IResult<ProviderPayment> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (settlement.to !== payeeId) return Result.fail(new RefundNotPayeeException());
    if (settlement.method !== 'provider' || settlement.status !== 'paid' || !settlement.payment) {
      return Result.fail(new SettlementNotRefundableException());
    }
    if (!this.hasMember(settlement.from) || !this.hasMember(settlement.to))
      return Result.fail(new RefundPartyLeftException());
    return Result.ok(settlement.payment);
  }

  /**
   * The second step of a refund, with the provider's answer: a refund the provider did not accept is refused and nothing changes, and the
   * settlement stays paid. Otherwise the settlement is `refunding`: the money has not gone back yet, so the balances still count it, and
   * RefundRequested is recorded. The book is the one `proposeRefund` read, and the store refuses the save if another writer moved it since.
   */
  recordRefund(settlement: Settlement, accepted: boolean, archived: boolean): IResult<Settlement> {
    if (archived) return Result.fail(new GroupArchivedException());
    if (!accepted) return Result.fail(new RefundUnavailableException());
    this.record(
      RefundRequestedEvent.set({
        settlementId: settlement.id,
        groupId: settlement.groupId,
        from: settlement.from,
        to: settlement.to,
        amount: settlement.amount,
      }),
    );
    return Result.ok({ ...settlement, status: 'refunding' });
  }

  /**
   * What a draft settles in the group's currency (request 12, request 39): its `amount` when it is given in it, or, when it is paid in another
   * currency, the original amount converted at the rate offered, which the book decides with (a currency that is not Tally's or the group's, an
   * amount out of range, or no rate offered, is refused by name). A draft with neither is refused as an amount that is not one.
   */
  #paidIn({ amount, original }: SettlementDraft): IResult<{ amount: number; original?: OriginalAmount }> {
    if (original) {
      const decided = OriginalAmount.decide(original, this.#currency);
      if (decided.isFailure()) return Result.fail(decided.error);
      return Result.ok({ amount: decided.data.toGroupAmount(this.#currency), original: decided.data });
    }
    if (amount === undefined) return Result.fail(new InvalidSettlementAmountException());
    return Result.ok({ amount });
  }

  /**
   * The refusal of a settlement between two members, or `undefined` when it holds: the payee is a member of the group (else the
   * group's `404`), the amount is a whole number of 1 or more, the payer is a member and not the payee, the amount is no more than
   * the payer still owes, and no more than the payee is still owed.
   */
  #refusalOf({
    from,
    to,
    amount,
  }: {
    readonly from: string;
    readonly to: string;
    readonly amount: number;
  }): Exception | undefined {
    if (!this.hasMember(to)) return new GroupNotFoundException();
    if (!Number.isInteger(amount) || amount < 1) return new InvalidSettlementAmountException();
    if (from === to) return new PayeeIsPayerException();
    if (!this.hasMember(from)) return new PayerNotInGroupException();
    if (amount > -this.balanceOf(from)) return new MoreThanPayerOwesException();
    if (amount > this.balanceOf(to)) return new MoreThanPayeeIsOwedException();
    return undefined;
  }
}

/**
 * The status a provider's verdict moves a payment to, or `undefined` when the verdict changes nothing (requests 13, 14 and 15). A
 * `refunded` verdict takes a payment that is pending, paid or refunding; any other takes only a pending one, to paid or failed.
 */
const endedBy = (settlement: Settlement, verdict: string): 'refunded' | 'paid' | 'failed' | undefined => {
  if (verdict === 'refunded') {
    const refundable =
      settlement.status === 'pending' || settlement.status === 'paid' || settlement.status === 'refunding';
    return refundable ? 'refunded' : undefined;
  }
  if (settlement.status !== 'pending') return undefined;
  if (verdict === 'succeeded') return 'paid';
  if (verdict === 'failed') return 'failed';
  return undefined;
};
