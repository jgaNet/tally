import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain/Email';

import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';

/**
 * One signed-in person, known by an email (unique, whatever its case) and by one name in every group
 * (docs/adr/0002). Its password is kept only as the hash the password hasher made of it.
 *
 * `create()` is the sign-up: the values it is given are already valid (an Email, an AccountName, a hash
 * of a valid Password), its id is generated here, and it records AccountRegistered for the store to make
 * durable with it. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted
 * data. The store saves the account and checks its version.
 */
export class Account extends AggregateRoot {
  readonly #email: Email;
  readonly #name: AccountName;
  readonly #passwordHash: string;

  private constructor(id: Id, email: Email, name: AccountName, passwordHash: string, version: number) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
  }

  static create({ email, name, passwordHash }: { email: Email; name: AccountName; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.passwordHash) {
      throw new Error(`The account ${snapshot.id} is corrupted in the store`);
    }
    return new Account(new Id(snapshot.id), email.data, name.data, snapshot.passwordHash, snapshot.version);
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get email(): string {
    return this.#email.value;
  }

  get name(): string {
    return this.#name.value;
  }

  get passwordHash(): string {
    return this.#passwordHash;
  }
}
