import { IResult } from '@Architecture/Domain';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * The payout accounts, as aggregates: one per member. It loads and saves them. A save is refused with a
 * ConcurrencyConflictException when the account is no longer at the version it was read at (CONC-OPTIMISTIC).
 */
export interface IPayoutAccountRepository {
  /** The payout account of the member, or null when the member has none. */
  findByOwner(owner: string): Promise<PayoutAccount | null>;
  save(account: PayoutAccount): Promise<IResult>;
}
