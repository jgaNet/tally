import { IResult } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';

/**
 * The store of accounts as aggregates: loads and saves one, and answers the one fact the sign-up rule needs
 * about the collection (is this email taken). It never searches for a screen; that is IAccountQueries.
 */
export interface IAccountRepository {
  /** The account with this id, or null when there is none. */
  findById(id: string): Promise<Account | null>;
  /** The account that uses this email, or null when no account does. */
  findByEmail(email: Email): Promise<Account | null>;
  /**
   * Stores the account at the version it was read at plus one. An account no longer at the stored version is
   * refused with a ConcurrencyConflictException (CONC-OPTIMISTIC).
   */
  save(account: Account): Promise<IResult>;
}
