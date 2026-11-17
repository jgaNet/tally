import { Id, IResult } from '@Architecture/Domain';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

export interface IPayoutAccountRepository {
  /** The payout account of the person, or null when they have not set one. */
  findByOwner(owner: Id): Promise<PayoutAccount | null>;
  /**
   * Stores the account at its version + 1 (or opens it at version 1, for a person's first account). It runs in the command's
   * transaction. An account another writer changed first, or opened first, is a ConcurrencyConflict, and the command reads and
   * decides again.
   */
  save(account: PayoutAccount): Promise<IResult>;
}
