import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountRegisteredEvent } from './AccountEvents';
import { AccountName } from './AccountName';

/** An account as it is stored: its email normalised, its name trimmed, its password as a hash. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
}

/**
 * One signed-in person, known by an email, with one name in every group (ADR 2). Its id is born here, once; its
 * rules are the decision's (`Account.decision.ts`), which checks what it is given before it is made.
 */
export class Account extends AggregateRoot {
  readonly #email: Email;
  readonly #name: AccountName;
  readonly #passwordHash: string;

  private constructor(id: Id, email: Email, name: AccountName, passwordHash: string) {
    super(id);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
  }

  /** A new account, with its id generated here, recording that it was registered at `at`. */
  static create({
    email,
    name,
    passwordHash,
    at,
  }: {
    email: Email;
    name: AccountName;
    passwordHash: string;
    at: Date;
  }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, registeredAt: at }));
    return account;
  }

  /** Rebuilds an account from what was stored. It records nothing, and throws on corrupted data. */
  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    if (email.isFailure()) throw new Error(`Corrupted account ${snapshot.id}: its email is not one`);
    const name = AccountName.create(snapshot.name);
    if (name.isFailure()) throw new Error(`Corrupted account ${snapshot.id}: its name is not one`);
    if (!snapshot.passwordHash) throw new Error(`Corrupted account ${snapshot.id}: it has no password`);
    return new Account(new Id(snapshot.id), email.data, name.data, snapshot.passwordHash);
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

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
    };
  }
}
