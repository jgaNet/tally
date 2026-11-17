import { Id, IResult } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';

export interface IAccountRepository {
  findById(id: Id): Promise<Account | null>;
  /** The account that uses this email, whatever its case: the email is compared as `Email` normalises it. */
  findByEmail(email: Email): Promise<Account | null>;
  /**
   * Stores the account at its version + 1. Fails with EmailAlreadyUsed when another account has taken the email
   * since it was looked for (two sign-ups at once, on one server or two), and with a ConcurrencyConflictException
   * when the account is no longer at the version it was read at.
   */
  save(account: Account): Promise<IResult>;
}
