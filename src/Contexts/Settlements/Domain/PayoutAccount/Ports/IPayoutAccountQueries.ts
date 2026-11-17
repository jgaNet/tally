/** A member's payout account as the member reads it: the provider's id of it. */
export interface PayoutAccountView {
  accountId: string;
}

/** The read side of payout accounts: read models, never aggregates (QUERY-READ-MODELS). */
export interface IPayoutAccountQueries {
  /** The payout account of the member, or null when the member has none. */
  findByOwner(owner: string): Promise<PayoutAccountView | null>;
}
