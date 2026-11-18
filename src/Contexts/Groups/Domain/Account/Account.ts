import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain/Email';
import { Role } from '@SharedKernel/Domain';

import { AccountSnapshot, AdministratorChange } from '@Contexts/Groups/Domain/Account/DTOs';
import {
  AccountRegisteredEvent,
  AccountReinstatedEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';

/**
 * One signed-in person, known by an email (unique, whatever its case) and by one name in every group
 * (docs/adr/0002). Its password is kept only as the hash the password hasher made of it.
 *
 * `create()` is the sign-up: the values it is given are already valid (an Email, an AccountName, a hash
 * of a valid Password), its id is generated here, and it records AccountRegistered for the store to make
 * durable with it. `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted
 * data. The store saves the account and checks its version.
 *
 * `suspend()` and `reinstate()` are an administrator's (request 34, docs/adr/0034): each changes the account only when it is not
 * already so, records its event and its entry of the administrators' log (`changes`, which the store writes with the account), and
 * answers whether it changed anything. A suspended account is refused by the other contexts, which ask `isSuspended`.
 */
export class Account extends AggregateRoot {
  readonly #email: Email;
  readonly #name: AccountName;
  readonly #passwordHash: string;
  #suspended: boolean;
  /** The administrators' log entries made since the account was read: the store writes each with the change (docs/adr/0034). */
  readonly #changes: AdministratorChange[] = [];

  private constructor(
    id: Id,
    email: Email,
    name: AccountName,
    passwordHash: string,
    suspended: boolean,
    version: number,
  ) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
    this.#suspended = suspended;
  }

  static create({ email, name, passwordHash }: { email: Email; name: AccountName; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, false, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.passwordHash || typeof snapshot.suspended !== 'boolean') {
      throw new Error(`The account ${snapshot.id} is corrupted in the store`);
    }
    return new Account(
      new Id(snapshot.id),
      email.data,
      name.data,
      snapshot.passwordHash,
      snapshot.suspended,
      snapshot.version,
    );
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      suspended: this.#suspended,
      version: this.version,
    };
  }

  /**
   * The role this account has when it signs in: administrator when its email is one of the administrators' (ADMIN_EMAILS, whatever their
   * case), user otherwise. Nothing is recorded: the role is given to the sign-in's token and to no one through the API (docs/adr/0033).
   */
  roleAmong(administratorEmails: readonly string[]): Role {
    const administrators = administratorEmails.map(each => each.trim().toLowerCase());
    return administrators.includes(this.#email.value) ? Role.ADMIN : Role.USER;
  }

  /**
   * Suspends the account, for an administrator `by` (request 34). Answers `true` when it was not suspended and is now, recording
   * AccountSuspended and its log entry; `false`, and nothing recorded, when it already was.
   */
  suspend({ by, at }: { by: string; at: Date }): boolean {
    if (this.#suspended) return false;
    this.#suspended = true;
    this.#log({ by, at, action: 'suspended' });
    this.record(AccountSuspendedEvent.set({ accountId: this._id.value }));
    return true;
  }

  /**
   * Reinstates a suspended account, for an administrator `by` (request 34). Answers `true` when it was suspended and is not now, recording
   * AccountReinstated and its log entry; `false`, and nothing recorded, when it was not suspended.
   */
  reinstate({ by, at }: { by: string; at: Date }): boolean {
    if (!this.#suspended) return false;
    this.#suspended = false;
    this.#log({ by, at, action: 'reinstated' });
    this.record(AccountReinstatedEvent.set({ accountId: this._id.value }));
    return true;
  }

  #log({ by, at, action }: { by: string; at: Date; action: AdministratorChange['action'] }): void {
    this.#changes.push({
      id: Id.generate().value,
      at: at.toISOString(),
      by,
      action,
      subjectId: this._id.value,
    });
  }

  /** The administrators' log entries this account made since it was read, the oldest first: the store writes them with it. */
  get changes(): readonly AdministratorChange[] {
    return this.#changes;
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

  get isSuspended(): boolean {
    return this.#suspended;
  }
}
