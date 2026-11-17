import { Id, IResult, Result } from '@Architecture/Domain';
import { InMemoryDataSource } from '@Architecture/Infrastructure/DataSources/InMemoryDataSource';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';

/** The accounts' repository over memory, for the specs of the handlers that use it. */
export class InMemoryAccountRepository implements IAccountRepository {
  constructor(readonly dataSource = new InMemoryDataSource<AccountSnapshot>()) {}

  async findById(id: Id): Promise<Account | null> {
    const snapshot = this.dataSource.collection.get(id.value);
    return snapshot ? Account.fromSnapshot(snapshot) : null;
  }

  async findByEmail(email: Email): Promise<Account | null> {
    const snapshot = [...this.dataSource.collection.values()].find(candidate => candidate.email === email.value);
    return snapshot ? Account.fromSnapshot(snapshot) : null;
  }

  async save(account: Account): Promise<IResult> {
    const snapshot = account.toSnapshot();
    this.dataSource.collection.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
    return Result.ok();
  }
}
