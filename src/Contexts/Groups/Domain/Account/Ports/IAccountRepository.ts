import { IResult } from '@Architecture/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';

/**
 * The store of accounts: loads and saves whole aggregates, and answers the one fact the sign-up rule
 * needs about the collection (is this email taken?). Used inside a transaction only (docs/adr/0002).
 */
export interface IAccountRepository {
  findById(id: string): Promise<Account | undefined>;
  /** The account that uses this email, whatever its case. */
  findByEmail(email: string): Promise<Account | undefined>;
  /** Stores the account at version + 1; refuses it with a ConcurrencyConflict when the stored version is not the one read. */
  save(account: Account): Promise<IResult<undefined>>;
}
