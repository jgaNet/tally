import { IResult, Result } from '@Architecture/Domain';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * The accounts' store in a Map, for the use cases' unit specs: the same rules as the SQLite store (one
 * account per email, whatever its case; a version checked on save), with no file under it.
 */
export class InMemoryAccountRepository implements IAccountRepository {
  readonly accounts = new Map<string, Account>();

  async findById(id: string): Promise<Account | undefined> {
    return this.accounts.get(id);
  }

  async findByEmail(email: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find(account => account.email === email.toLowerCase());
  }

  async save(account: Account): Promise<IResult<undefined>> {
    const taken = await this.findByEmail(account.email);
    if (taken && taken.id !== account.id) return Result.fail(new EmailAlreadyUsedException());
    this.accounts.set(account.id, account);
    return Result.ok(undefined);
  }
}
