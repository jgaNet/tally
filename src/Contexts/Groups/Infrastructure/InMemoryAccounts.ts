import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAccountCredentials } from '@Contexts/Groups/Application/Ports/IAccountCredentials';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';
import { CredentialsReadModel } from '@Contexts/Groups/Application/ReadModel/CredentialsReadModel';

/** The accounts kept in memory, shared by the in-memory adapters of the three ports, for the specs. */
export type InMemoryAccountStore = Map<string, AccountSnapshot>;

export class InMemoryAccountRepository implements IAccountRepository {
  constructor(private store: InMemoryAccountStore = new Map()) {}

  async findById(id: Id): Promise<Account | null> {
    const snapshot = this.store.get(id.value);
    return snapshot ? Account.fromSnapshot(snapshot) : null;
  }

  async findByEmail(email: Email): Promise<Account | null> {
    const snapshot = [...this.store.values()].find(kept => kept.email === email.value);
    return snapshot ? Account.fromSnapshot(snapshot) : null;
  }

  async save(account: Account): Promise<IResult> {
    const snapshot = account.toSnapshot();
    if (
      snapshot.email !== null &&
      [...this.store.values()].some(other => other.id !== snapshot.id && other.email === snapshot.email)
    ) {
      return Result.fail(new EmailAlreadyUsed());
    }
    if ((this.store.get(snapshot.id)?.version ?? 0) !== snapshot.version) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The account has changed', { id: snapshot.id }));
    }
    this.store.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
    return Result.ok();
  }
}

export class InMemoryAccountReadModels implements IAccountQueries, IAccountCredentials {
  constructor(private store: InMemoryAccountStore) {}

  async findById(id: string): Promise<AccountReadModel | null> {
    const snapshot = this.store.get(id);
    return snapshot && snapshot.email !== null && snapshot.deletedAt === null
      ? { id: snapshot.id, email: snapshot.email, name: snapshot.name }
      : null;
  }

  async isDeleted(id: string): Promise<boolean> {
    return this.store.get(id)?.deletedAt != null;
  }

  async findByEmail(email: string): Promise<CredentialsReadModel | null> {
    const snapshot = [...this.store.values()].find(kept => kept.email === email);
    return snapshot ? { accountId: snapshot.id, passwordHash: snapshot.passwordHash } : null;
  }
}
