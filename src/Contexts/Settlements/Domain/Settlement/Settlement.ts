/**
 * How a settlement is paid: in cash, recorded by its payee (request 12), through the payment provider (request 13), or by netting two
 * members' debts across their groups (request 32), which moves no money and counts at once.
 */
export type SettlementMethod = 'cash' | 'provider' | 'net';

/**
 * Where a settlement stands: a provider's payment is `pending` until the provider says it ended: `paid` or `failed`, and a paid one
 * may be refunded: `refunding` once Tally has asked the provider, `refunded` once the provider says so (request 15). A cash
 * settlement is `paid` from the moment it is recorded. A payment moves forward only, and ends at `failed` or `refunded`. A paid payment
 * may be `contested` by its payee (request 33): it waits, and is then `paid` again, or `annulled` when an administrator decides so.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/** The provider's payment a settlement through the provider is: the id the provider answered, and the link the payer pays at. */
export interface ProviderPayment {
  readonly id: string;
  readonly payUrl: string;
}

/** Who bears the provider's fee of a payment: its payer, its payee, or both, each half (request 38). */
export type FeeBearer = 'payer' | 'payee' | 'shared';

/** The provider's answer to a payment request (request 38): its payment, and the fee the provider keeps out of what it pays the payee. */
export interface ProviderLink extends ProviderPayment {
  /** The fee, a whole number of hundredths of the payment's currency, 0 or more. */
  readonly fee: number;
}

/** The fee a settlement through the provider was asked with: its amount, and who bore it when it was asked for (request 38). */
export interface ProviderFee {
  readonly amount: number;
  readonly borneBy: FeeBearer;
}

/**
 * The part of the fee the payer bears, in hundredths (request 38): all of it when the payer bears it, half of it (rounded down, so the
 * payee bears the extra hundredth of an odd fee) when it is shared, none when the payee bears it.
 */
export const payerBearsOf = ({ amount, borneBy }: ProviderFee): number => {
  if (borneBy === 'payer') return amount;
  if (borneBy === 'shared') return Math.floor(amount / 2);
  return 0;
};

/**
 * What a settlement settles, in hundredths (request 38): what the balances, what is still owed while it waits, the statement and the audit
 * count. Its amount less the part of the fee its payer bears; its whole amount when it has no fee, or the payee bears it.
 */
export const settledAmountOf = (settlement: Settlement): number =>
  settlement.fee ? settlement.amount - payerBearsOf(settlement.fee) : settlement.amount;

/**
 * A settlement, as the domain records it (requests 12 and 13, conventions/domain.yaml): one transfer from a payer to a payee of a
 * group, whole in the group's currency's hundredths, at least 1, and decided when it was recorded. It is kept as it was decided,
 * except its status, which moves once from `pending` to `paid` or `failed` when the provider says so (ADR 10, feature 13). What it
 * does to the balances is read from it, never written back.
 */
export interface Settlement {
  readonly id: string;
  readonly groupId: string;
  /** The payer: the member who paid the money. */
  readonly from: string;
  /** The payee: the member who received it, and who recorded it (in cash), or who is to receive it (through the provider). */
  readonly to: string;
  readonly amount: number;
  readonly method: SettlementMethod;
  readonly status: SettlementStatus;
  /** When it was decided, as an ISO 8601 instant. */
  readonly at: string;
  /** Present on a settlement through the provider only. */
  readonly payment?: ProviderPayment;
  /**
   * The provider's fee and who bore it, as they were when the payment was asked for (request 38). Absent on a settlement asked for before
   * request 38, and on one in cash or netted; a settlement through the provider asked for from then on has it.
   */
  readonly fee?: ProviderFee;
  /**
   * When it was contested (request 33), set once: a settlement is contested at most once, so its presence says it was contested before, even
   * when an administrator has since decided it was paid.
   */
  readonly contestedAt?: string;
}
