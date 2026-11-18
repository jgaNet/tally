import { Id } from '@Architecture/Domain';

/** How a settlement is paid: in cash, recorded by its payee, through the payment provider, or by netting what two people owe each other across their groups (request 32). */
export type SettlementMethod = 'cash' | 'provider' | 'net';

/**
 * Where a settlement stands: `pending` while the provider has not said how its payment ended, then `paid` or `failed`; a paid
 * settlement through the provider may be `refunding` (Tally asked the provider to refund it, the money is not back yet) and then
 * `refunded`, or be `refunded` straight from `pending` when the provider's refund overtakes its success (request 15).
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/** What the provider's webhook says a payment became, which the settlement moves to. */
export type PaymentOutcome = 'paid' | 'failed' | 'refunded';

/** A payment through the provider: the provider's id for it, and the link the payer pays at. */
export interface ProviderPayment {
  readonly paymentId: string;
  readonly payUrl: string;
}

/** A status a settlement had, and when Tally learned it (request 19). */
export interface SettlementLine {
  readonly status: SettlementStatus;
  readonly at: Date;
}

/**
 * One settlement, as the book keeps it: `payer` pays `payee` the `amount` of a group, by `method`, at `at`. A cash settlement is
 * `paid` from the moment it is recorded. A settlement through the provider is `pending` until the provider's webhook says it
 * `paid` or `failed` (`end`), and carries the provider's payment. A paid one may be refunded through the provider (`startRefund`, then
 * `end('refunded')`). It is decided by the book and never changed otherwise. Every status it has had is kept in `history`, the
 * earliest first, each with when Tally learned it: a line is added by each of those moves and by nothing else.
 */
export class Settlement {
  private currentStatus: SettlementStatus;
  private readonly lines: SettlementLine[];

  constructor(
    readonly id: Id,
    readonly groupId: Id,
    readonly payer: Id,
    readonly payee: Id,
    readonly amount: number,
    readonly method: SettlementMethod,
    status: SettlementStatus,
    readonly at: Date,
    readonly provider: ProviderPayment | null,
    /** The lines kept so far, the earliest first; the last one is the status the settlement has now. */
    history: readonly SettlementLine[],
  ) {
    this.currentStatus = status;
    this.lines = [...history];
  }

  get status(): SettlementStatus {
    return this.currentStatus;
  }

  /** Every status the settlement has had, the earliest first. */
  get history(): readonly SettlementLine[] {
    return this.lines;
  }

  /** The provider has said how the payment ended: it is no longer waiting, or it was refunded. The book decides the move. */
  end(outcome: PaymentOutcome, learnedAt: Date): SettlementLine {
    return this.learn(outcome, learnedAt);
  }

  /** The payee says the money did not arrive: the settlement waits, held, until an administrator decides it (request 33). */
  contest(learnedAt: Date): SettlementLine {
    return this.learn('contested', learnedAt);
  }

  /** An administrator decided the contested settlement: it was paid, and counts again, or it was not, and is annulled (request 33). */
  decide(paid: boolean, learnedAt: Date): SettlementLine {
    return this.learn(paid ? 'paid' : 'annulled', learnedAt);
  }

  /** Tally asked the provider to refund the paid payment: the money has not gone back yet, so the settlement still counts. */
  startRefund(learnedAt: Date): SettlementLine {
    return this.learn('refunding', learnedAt);
  }

  private learn(status: SettlementStatus, learnedAt: Date): SettlementLine {
    this.currentStatus = status;
    const line: SettlementLine = { status, at: learnedAt };
    this.lines.push(line);
    return line;
  }
}
