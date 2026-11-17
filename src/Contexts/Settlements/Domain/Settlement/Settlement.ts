import { Id } from '@Architecture/Domain';

/** How a settlement is paid: in cash, recorded by its payee, or through the payment provider. */
export type SettlementMethod = 'cash' | 'provider';

/**
 * Where a settlement stands: `pending` while the provider has not said how its payment ended, then `paid` or `failed`; a paid
 * settlement through the provider may be `refunding` (Tally asked the provider to refund it, the money is not back yet) and then
 * `refunded`, or be `refunded` straight from `pending` when the provider's refund overtakes its success (request 15).
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

/** What the provider's webhook says a payment became, which the settlement moves to. */
export type PaymentOutcome = 'paid' | 'failed' | 'refunded';

/** A payment through the provider: the provider's id for it, and the link the payer pays at. */
export interface ProviderPayment {
  readonly paymentId: string;
  readonly payUrl: string;
}

/**
 * One settlement, as the book keeps it: `payer` pays `payee` the `amount` of a group, by `method`, at `at`. A cash settlement is
 * `paid` from the moment it is recorded. A settlement through the provider is `pending` until the provider's webhook says it
 * `paid` or `failed` (`end`), and carries the provider's payment. A paid one may be refunded through the provider (`startRefund`, then
 * `end('refunded')`). It is decided by the book and never changed otherwise.
 */
export class Settlement {
  private currentStatus: SettlementStatus;

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
  ) {
    this.currentStatus = status;
  }

  get status(): SettlementStatus {
    return this.currentStatus;
  }

  /** The provider has said how the payment ended: it is no longer waiting, or it was refunded. The book decides the move. */
  end(outcome: PaymentOutcome): void {
    this.currentStatus = outcome;
  }

  /** Tally asked the provider to refund the paid payment: the money has not gone back yet, so the settlement still counts. */
  startRefund(): void {
    this.currentStatus = 'refunding';
  }
}
