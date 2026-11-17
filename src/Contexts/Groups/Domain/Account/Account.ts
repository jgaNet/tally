import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
import { Name } from '@Contexts/Groups/Domain/Account/Name';

/**
 * One person: known by an email, with one name in every group, and a password they prove it with.
 * Whether an email is already used is a fact about the collection, which the sign-up asks the repository for.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    readonly email: Email,
    readonly name: Name,
    readonly passwordHash: string,
    version: number,
  ) {
    super(id, version);
  }

  static register({ email, name, passwordHash }: { email: Email; name: Name; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = Name.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.passwordHash) {
      throw new Error(`The account ${snapshot.id} is corrupted`);
    }
    return new Account(new Id(snapshot.id), email.data, name.data, snapshot.passwordHash, snapshot.version);
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
