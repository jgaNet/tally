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
    this.accounts.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
  }

  async credentialsOf(email: string): Promise<AccountCredentials | undefined> {
    const account = this.#byEmail(email);
    return account && { id: account.id, passwordHash: account.passwordHash };
  }

  async view(id: string): Promise<AccountView | undefined> {
    const account = this.accounts.get(id);
    return account && { id: account.id, email: account.email, name: account.name };
  }

  async find(id: string): Promise<Account | undefined> {
    const snapshot = this.accounts.get(id);
    return snapshot && Account.fromSnapshot(snapshot);
  }

  async save(account: Account): Promise<void> {
    const snapshot = account.toSnapshot();
    const stored = this.accounts.get(snapshot.id);
    if (!stored || stored.version !== snapshot.version) {
      throw new ConcurrencyConflictException('Groups', 'The account changed since it was read: read it again');
    }
    this.accounts.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
  }

  #byEmail(email: string): AccountSnapshot | undefined {
    const normal = Email.create(email);
    if (normal.isFailure()) return undefined;
    return [...this.accounts.values()].find(account => account.email === normal.data.value);
  }
}
