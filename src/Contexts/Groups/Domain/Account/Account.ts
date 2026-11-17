import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { IAccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

/**
 * Account is the aggregate root of Groups' accounts: one person who signs in, known by an email, with the
 * one name every group they are in shows (ADR 1). Its name and email are value objects, so an account once
 * held is valid; the hash it keeps is the hasher's, of a password the registration validated.
 *
 * The email must be unique across accounts. That rule spans the whole collection, so it lives in the
 * AccountRegistration domain service, not here. Nothing in an account changes after it is opened: a sign-in
 * records nothing (the storm's decision), so no behaviour is needed beyond the creation.
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

  /** Opens a new account: its id is generated here, and the creation is recorded. */
  static create({ email, name, passwordHash }: { email: Email; name: AccountName; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value }));
    return account;
  }

  /** Rebuilds an account from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IAccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.passwordHash) {
      throw new Error(`Corrupted account ${snapshot._id}`);
    }
    return new Account(new Id(snapshot._id), email.data, name.data, snapshot.passwordHash, snapshot.version);
  }

  toSnapshot(): IAccountSnapshot {
    return {
      _id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      version: this.version,
    };
  }

  get email(): Email {
    return this.#email;
  }

  get name(): AccountName {
    return this.#name;
  }

  get passwordHash(): string {
    return this.#passwordHash;
  }
}
