import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';

/**
 * The accounts, as aggregates: found by their email (a fact the sign-up rule needs) or by their id (an administrator's suspension), inserted
 * as a whole, and saved at the version they were read at (CONC-OPTIMISTIC). Two servers may share the store, so `insert` answers `false` when
 * another account took the email first (the unique index), and `save` throws `ConcurrencyConflictException` over a newer version.
 */
export interface IAccountRepository {
  findByEmail(email: Email): Promise<Account | undefined>;
  findById(id: string): Promise<Account | undefined>;
  insert(account: Account): Promise<boolean>;
  /** Stores the account's suspension, at the version it was loaded at, and the version after it. */
  save(account: Account): Promise<void>;
  /** Runs `work` in one transaction on the accounts' store: a suspension and its entry of the administrators' log are written together (request 34). */
  inTransaction<T>(work: () => Promise<T>): Promise<T>;
}
