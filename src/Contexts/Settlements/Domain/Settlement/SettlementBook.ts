import { AggregateRoot, Exception, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import {
  PaymentRequestedEvent,
  RefundRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
  SettlementRefundedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  CashSettlementNotRefundable,
  InvalidSettlementAmount,
  NotThePayee,
  PayeeHasNoPayoutAccount,
  PayeeNotAMember,
  PayerIsPayee,
  PayerNotAMember,
  SettlementExceedsDebt,
  SettlementNotPaid,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

export type SettlementMethod = 'cash' | 'provider';
/** A settlement is pending until the provider says how its payment ended; a paid one may be refunded, and then refunding and refunded (ADR 9). */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

/** A status a settlement has had, and when Tally learned it (request 19). */
export interface SettlementStatusLine {
  readonly status: SettlementStatus;
  readonly at: Date;
}

/** A status a settlement took in this transaction, for the repository to store with the settlement (request 19). */
export interface SettlementStatusChange extends SettlementStatusLine {
  readonly settlementId: Id;
}

/** A settlement of the group: who paid whom, how much, how it is paid, its status, and when it was recorded. */
export interface Settlement {
  readonly id: Id;
  readonly groupId: Id;
  readonly payer: Id;
  readonly payee: Id;
  readonly amount: number;
  readonly method: SettlementMethod;
  status: SettlementStatus;
  readonly at: Date;
  /** Every status the settlement has had, the earliest first, each with when Tally learned it (request 19). Its last line is `status`. */
  readonly history: SettlementStatusLine[];
  /** The payment's id at the provider, for a settlement through the provider. */
  readonly providerPaymentId?: string;
  /** The link the payer pays at, for a settlement through the provider. */
  readonly payUrl?: string;
}

/** What a settlement is decided on: who pays whom, how much, and the balances and members the caller read in its transaction. */
export interface SettlementDecision {
  payer: Id;
  payee: Id;
  amount: number;
  balances: ReadonlyMap<string, number>;
  members: readonly string[];
}

/** A payment through the provider the book checked and will keep once the provider has given its link (ADR 8). */
export interface PaymentProposal extends SettlementDecision {
  /** The settlement's id, which is the reference the provider is asked with. */
  readonly id: Id;
  /** The provider's id of the payee's payout account, which the payment is paid to (request 16, ADR 10). */
  readonly payeeAccount: string;
}

/** A refund the book checked, to ask the provider for: the settlement it refunds, and the payment's id at the provider. */
export interface RefundProposal {
  readonly settlementId: Id;
  readonly paymentId: string;
}

/**
 * The settlements of one group, decided in one place (conventions/domain.yaml, ADR 7, ADR 8). A payee records, in cash, a
 * payment a member made them; a payer asks to pay through the provider, and the provider later says whether it succeeded
 * or failed. The book refuses a settlement unless the amount is a whole number of at least 1, the payer and the payee are
 * two different members, and the amount is no more than what the payer still owes and no more than what the payee is still
 * owed. A payment waiting at the provider counts as paid for that, so the book adds what is waiting to the balances it is
 * given; the balances themselves count a settlement only once it is paid. The caller reads the balances in the same
 * transaction; the book's version (CONC-OPTIMISTIC) makes a second settlement decided at once re-read them.
 */
export class SettlementBook extends AggregateRoot {
  #settlements: Settlement[];
  #unsaved = new Set<Settlement>();
  #unsavedHistory: SettlementStatusChange[] = [];

  private constructor(groupId: Id, version: number, settlements: Settlement[]) {
    super(groupId, version);
    this.#settlements = settlements;
  }

  /** The book of a group, at the version it was read at, with the settlements stored in it; 0 when none was ever stored. */
  static open(groupId: Id, version: number, settlements: readonly Settlement[] = []): SettlementBook {
    return new SettlementBook(groupId, version, [...settlements]);
  }

  /** The settlements the book decided or changed since it was read, for the repository to store. */
  get unsaved(): readonly Settlement[] {
    return [...this.#unsaved];
  }

  /** The statuses settlements took since the book was read, in the order they were taken, for the repository to store. */
  get unsavedHistory(): readonly SettlementStatusChange[] {
    return [...this.#unsavedHistory];
  }

  /** A payee's payment in cash, decided now: recorded as paid, and SettlementRecorded. */
  recordCash({ at, ...decision }: SettlementDecision & { at: Date }): IResult<Settlement> {
    const refusal = this.#refusal(decision);
    if (refusal) return Result.fail(refusal);
    const settlement = this.#keep({
      id: Id.generate(),
      groupId: this._id,
      payer: decision.payer,
      payee: decision.payee,
      amount: decision.amount,
      method: 'cash',
      status: 'paid',
      at,
    });
    this.record(
      SettlementRecordedEvent.set({
        settlementId: settlement.id.value,
        groupId: this._id.value,
        payer: settlement.payer.value,
        payee: settlement.payee.value,
        amount: settlement.amount,
        recordedAt: at.toISOString(),
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * A payer asks to pay through the provider: the rules are checked now, and the id the provider is asked with is made; nothing
   * is kept until the provider has answered (`keepPayment`). The payee must have a payout account at the provider (request 16):
   * `payeeAccount` is that account's id, read by the caller from the payee's PayoutAccount, and is undefined when the payee has
   * none, which is refused before the provider is asked.
   */
  proposePayment({
    payeeAccount,
    ...decision
  }: SettlementDecision & { payeeAccount: string | undefined }): IResult<PaymentProposal> {
    const refusal = this.#refusal(decision);
    if (refusal) return Result.fail(refusal);
    if (payeeAccount === undefined) return Result.fail(new PayeeHasNoPayoutAccount());
    return Result.ok({ ...decision, id: Id.generate(), payeeAccount });
  }

  /**
   * Keeps a payment the provider gave a link for: the rules are decided again with the link in hand, and the settlement is
   * kept pending, not counted, with its link; PaymentRequested is recorded.
   */
  keepPayment(proposal: PaymentProposal, link: { id: string; payUrl: string }, at: Date): IResult<Settlement> {
    const refusal = this.#refusal(proposal);
    if (refusal) return Result.fail(refusal);
    const settlement = this.#keep({
      id: proposal.id,
      groupId: this._id,
      payer: proposal.payer,
      payee: proposal.payee,
      amount: proposal.amount,
      method: 'provider',
      status: 'pending',
      at,
      providerPaymentId: link.id,
      payUrl: link.payUrl,
    });
    this.record(
      PaymentRequestedEvent.set({
        settlementId: settlement.id.value,
        groupId: this._id.value,
        payer: settlement.payer.value,
        payee: settlement.payee.value,
        amount: settlement.amount,
        payUrl: link.payUrl,
        requestedAt: at.toISOString(),
      }),
    );
    return Result.ok(settlement);
  }

  /**
   * A payee asks to refund a settlement paid through the provider, whole (request 15, ADR 9). The caller must be a member of
   * the group, or the settlement does not exist for them; the payee, and no one else; a settlement paid through the provider,
   * and still `paid`; and its payer and payee must still be members, so the balances of the group still add up to 0. Nothing
   * is changed: the provider is asked with the payment's id, and `keepRefund` keeps the settlement refunding once it said yes.
   */
  proposeRefund({
    settlementId,
    caller,
    members,
  }: {
    settlementId: Id;
    caller: Id;
    members: readonly string[];
  }): IResult<RefundProposal> {
    const settlement = this.#settlements.find(candidate => candidate.id.equals(settlementId));
    if (!settlement || !members.includes(caller.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));
    }
    if (!settlement.payee.equals(caller)) return Result.fail(new NotThePayee());
    if (settlement.method !== 'provider') return Result.fail(new CashSettlementNotRefundable());
    if (settlement.status !== 'paid') return Result.fail(new SettlementNotPaid());
    if (!members.includes(settlement.payer.value)) return Result.fail(new PayerNotAMember());
    if (!members.includes(settlement.payee.value)) return Result.fail(new PayeeNotAMember());
    if (settlement.providerPaymentId === undefined) {
      throw new Error('A settlement through the provider has no payment id at the provider: the book is corrupted');
    }
    return Result.ok({ settlementId, paymentId: settlement.providerPaymentId });
  }

  /** The provider accepted the refund: the settlement is refunding, still counted, and RefundRequested is recorded. */
  keepRefund(proposal: RefundProposal, at: Date): IResult {
    const settlement = this.#settlements.find(candidate => candidate.id.equals(proposal.settlementId));
    if (!settlement || settlement.status !== 'paid') return Result.fail(new SettlementNotPaid());
    this.#moveTo(settlement, 'refunding', at);
    this.record(
      RefundRequestedEvent.set({
        settlementId: settlement.id.value,
        groupId: this._id.value,
        payer: settlement.payer.value,
        payee: settlement.payee.value,
        amount: settlement.amount,
        requestedAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  /**
   * The provider's word on a payment. `succeeded` makes a pending settlement paid and `failed` makes it failed; `refunded`
   * makes a settlement refunded from any state it can be in: pending (a refund that overtakes the success), paid, or
   * refunding, and it is never counted again. Any other word, a payment this book does not know, and a word that the
   * settlement has already passed (a repeated one, a late `pending`, a `succeeded` after a refund) changes nothing.
   */
  receivePayment({ paymentId, status, at }: { paymentId: string; status: string; at: Date }): void {
    const settlement = this.#settlements.find(
      candidate => candidate.method === 'provider' && candidate.providerPaymentId === paymentId,
    );
    if (!settlement) return;

    const ended = {
      settlementId: settlement.id.value,
      groupId: this._id.value,
      payer: settlement.payer.value,
      payee: settlement.payee.value,
      amount: settlement.amount,
    };
    if (status === 'refunded') {
      if (settlement.status !== 'pending' && settlement.status !== 'paid' && settlement.status !== 'refunding') return;
      this.#moveTo(settlement, 'refunded', at);
      this.record(SettlementRefundedEvent.set(ended));
    } else if (settlement.status !== 'pending') {
      return;
    } else if (status === 'succeeded') {
      this.#moveTo(settlement, 'paid', at);
      this.record(SettlementPaidEvent.set(ended));
    } else if (status === 'failed') {
      this.#moveTo(settlement, 'failed', at);
      this.record(SettlementFailedEvent.set(ended));
    }
  }

  /** The refusal of a settlement on these balances, or none: the rules of a settlement, on what is still owed. */
  #refusal({ payer, payee, amount, balances, members }: SettlementDecision): Exception | undefined {
    if (!Number.isInteger(amount) || amount < 1) return new InvalidSettlementAmount();
    if (payer.equals(payee)) return new PayerIsPayee();
    if (!members.includes(payer.value)) return new PayerNotAMember();
    if (!members.includes(payee.value)) return new PayeeNotAMember();

    const owing = this.#stillOwing(balances);
    const owedByPayer = Math.max(0, -(owing.get(payer.value) ?? 0));
    const owedToPayee = Math.max(0, owing.get(payee.value) ?? 0);
    if (amount > owedByPayer || amount > owedToPayee) return new SettlementExceedsDebt();
    return undefined;
  }

  /** The balances as if every payment waiting at the provider were paid: what is still owed (ADR 8). */
  #stillOwing(balances: ReadonlyMap<string, number>): Map<string, number> {
    const owing = new Map(balances);
    for (const settlement of this.#settlements) {
      if (settlement.status !== 'pending') continue;
      owing.set(settlement.payer.value, (owing.get(settlement.payer.value) ?? 0) + settlement.amount);
      owing.set(settlement.payee.value, (owing.get(settlement.payee.value) ?? 0) - settlement.amount);
    }
    return owing;
  }

  /** A settlement kept for the first time: its first status is the one it was recorded or asked with. */
  #keep(settlement: Omit<Settlement, 'history'>): Settlement {
    const kept: Settlement = { ...settlement, history: [{ status: settlement.status, at: settlement.at }] };
    this.#settlements.push(kept);
    this.#unsaved.add(kept);
    this.#unsavedHistory.push({ settlementId: kept.id, status: kept.status, at: kept.at });
    return kept;
  }

  /** The settlement takes a new status, learned at `at`: its history and the statuses to store grow by it. */
  #moveTo(settlement: Settlement, status: SettlementStatus, at: Date): void {
    settlement.status = status;
    settlement.history.push({ status, at });
    this.#unsaved.add(settlement);
    this.#unsavedHistory.push({ settlementId: settlement.id, status, at });
  }
}
