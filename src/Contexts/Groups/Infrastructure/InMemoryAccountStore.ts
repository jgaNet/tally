import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountCredentials, AccountView, IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { Account, AccountSnapshot } from '@Contexts/Groups/Domain/Account/Account';

/** The store of accounts over a Map: what the use cases' specs double the database with. */
export class InMemoryAccountStore implements IAccountStore {
  readonly accounts = new Map<string, AccountSnapshot>();

  async emailTaken(email: string): Promise<boolean> {
    return this.#byEmail(email) !== undefined;
  }

  async add(account: Account): Promise<void> {
    const snapshot = account.toSnapshot();
    if (this.#byEmail(snapshot.email)) {
      throw new ConcurrencyConflictException('Groups', 'An account with this email was added at the same time');
    }
    this.accounts.set(snapshot.id, snapshot);
  }

  async credentialsOf(email: string): Promise<AccountCredentials | undefined> {
    const account = this.#byEmail(email);
    return account && { id: account.id, passwordHash: account.passwordHash };
  }

  async view(id: string): Promise<AccountView | undefined> {
    const account = this.accounts.get(id);
    return account && { id: account.id, email: account.email, name: account.name };
  }

  #byEmail(email: string): AccountSnapshot | undefined {
    const normal = Email.create(email);
    if (normal.isFailure()) return undefined;
    return [...this.accounts.values()].find(account => account.email === normal.data.value);
  }
}
