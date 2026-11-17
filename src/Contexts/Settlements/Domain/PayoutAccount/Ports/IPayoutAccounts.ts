import { IResult } from '@Architecture/Domain';

import { PayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/** The store of the payout accounts: loads and saves one person's account inside a transaction only (docs/adr/0016). */
export interface IPayoutAccounts {
  /** The person's account as it is stored, at the version it is at; a person with no account is at version 0 with none. */
  get(accountId: string): Promise<PayoutAccount>;
  /**
   * Stores the account if it is still at the version it was read at (CONC-OPTIMISTIC): a conflict otherwise. The store then holds
   * one version more.
   */
  save(account: PayoutAccount): Promise<IResult<undefined>>;
}
