import { Id, IResult } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';

export interface IAccountRepository {
  /** The account of this id as it was read (its version), or null. */
  findById(id: Id): Promise<Account | null>;
  /** The account that uses this email, whatever the case it was written in, or null. */
  findByEmail(email: Email): Promise<Account | null>;
  /** Stores the account at version + 1; refuses it with a ConcurrencyConflictException when it is no longer at the stored version. */
  save(account: Account): Promise<IResult>;
}
