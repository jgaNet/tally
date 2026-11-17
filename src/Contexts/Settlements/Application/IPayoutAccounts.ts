import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * The payout accounts, as the use cases load and save them: a port Settlements owns, answered by its own store (`SqlitePayoutAccounts`).
 * One per person (request 16); a repository loads it and saves it, and answers the one fact the payment decision needs of it: the
 * payee's account at the provider.
 */
export interface IPayoutAccounts {
  /** The payout account of this person as it is stored, at the version it was stored at; `undefined` when they have none. */
  ofOwner(ownerId: string): Promise<PayoutAccount | undefined>;
  /**
   * Stores the payout account at its version + 1. Refuses an account that is no longer at the stored version with a
   * `ConcurrencyConflictException`: the caller re-reads and decides again (CONC-OPTIMISTIC).
   */
  save(account: PayoutAccount): Promise<void>;
}
