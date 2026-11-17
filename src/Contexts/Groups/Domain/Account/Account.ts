import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

/**
 * An account: who a person is to the others, one email, one name in every group. It is made by
 * `register()`, which records the fact; the password is known only by its hash, which a port
 * computed and this class keeps as it was given.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly email: Email,
    readonly name: AccountName,
    readonly passwordHash: string,
  ) {
    super(id, version);
  }

  static register({ email, name, passwordHash }: { email: Email; name: AccountName; passwordHash: string }): Account {
    if (!passwordHash) throw new Error('An account is registered with the hash of its password');
    const account = new Account(Id.generate(), 0, email, name, passwordHash);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, email: email.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.id || !snapshot.passwordHash) {
      throw new Error(`Corrupted account ${snapshot.id}`);
    }
    return new Account(new Id(snapshot.id), snapshot.version, email.data, name.data, snapshot.passwordHash);
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.email.value,
      name: this.name.value,
      passwordHash: this.passwordHash,
      version: this.version,
    };
  }
}
