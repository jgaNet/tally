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
   * When it was contested (request 33), set once: a settlement is contested at most once, so its presence says it was contested before, even
   * when an administrator has since decided it was paid.
   */
  readonly contestedAt?: string;
}
