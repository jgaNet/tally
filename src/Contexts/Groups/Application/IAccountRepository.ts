import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';

/**
 * The accounts, as aggregates: found by their email (a fact the sign-up rule needs), inserted as a whole. Two servers
 * may share the store, so `insert` answers `false` when another account took the email first (the unique index).
 */
export interface IAccountRepository {
  findByEmail(email: Email): Promise<Account | undefined>;
  insert(account: Account): Promise<boolean>;
}
