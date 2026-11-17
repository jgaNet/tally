import { AggregateRoot, Exception, Id, IResult, Result } from '@Architecture/Domain';
import {
  PaymentRequestedEvent,
  SettlementFailedEvent,
  SettlementPaidEvent,
  SettlementRecordedEvent,
} from '@Contexts/Settlements/Domain/Settlement/Events/SettlementEvents';
import {
  InvalidSettlementAmount,
  PayeeNotAMember,
  PayerIsPayee,
  PayerNotAMember,
  SettlementExceedsDebt,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

export type SettlementMethod = 'cash' | 'provider';
export type SettlementStatus = 'pending' | 'paid' | 'failed';

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
   * is kept until the provider has answered (`keepPayment`).
   */
  proposePayment(decision: SettlementDecision): IResult<PaymentProposal> {
    const refusal = this.#refusal(decision);
    if (refusal) return Result.fail(refusal);
    return Result.ok({ ...decision, id: Id.generate() });
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
   * The provider's word on a payment: a pending settlement with that payment becomes paid when it succeeded, failed when it
   * failed, and changes for nothing else; a payment this book does not know, or one already ended, changes nothing.
   */
  receivePayment({ paymentId, status }: { paymentId: string; status: string }): void {
    const settlement = this.#settlements.find(
      candidate => candidate.method === 'provider' && candidate.providerPaymentId === paymentId,
    );
    if (!settlement || settlement.status !== 'pending') return;

    const ended = {
      settlementId: settlement.id.value,
      groupId: this._id.value,
      payer: settlement.payer.value,
      payee: settlement.payee.value,
      amount: settlement.amount,
    };
    if (status === 'succeeded') {
      settlement.status = 'paid';
      this.record(SettlementPaidEvent.set(ended));
    } else if (status === 'failed') {
      settlement.status = 'failed';
      this.record(SettlementFailedEvent.set(ended));
    } else {
      return;
    }
    this.#unsaved.add(settlement);
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

  #keep(settlement: Settlement): Settlement {
    const kept: Settlement = { ...settlement };
    this.#settlements.push(kept);
    this.#unsaved.add(kept);
    return kept;
  }
}
