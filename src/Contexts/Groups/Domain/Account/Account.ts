import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import {
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
/**
 * An account: who a person is to the others, one email, one name in every group. It is made by
 * `register()`, which records the fact; the password is known only by its hash, which a port
 * computed and this class keeps as it was given. An administrator may suspend it and reinstate it (request 34):
 * a suspended account starts nothing that records money, in any group, until it is reinstated, and nothing in a group changes.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly email: Email,
    readonly name: AccountName,
    readonly passwordHash: string,
    private _suspendedAt: Date | null = null,
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
    const suspendedAt = snapshot.suspendedAt ? new Date(snapshot.suspendedAt) : null;
    return new Account(
      new Id(snapshot.id),
      snapshot.version,
      email.data,
      name.data,
      snapshot.passwordHash,
      suspendedAt,
    );
  }

  /** Whether an administrator has suspended it and no one has reinstated it since (request 34). */
  get isSuspended(): boolean {
    return this._suspendedAt !== null;
  }

  /** The moment it was suspended, null while it is not suspended. */
  get suspendedAt(): Date | null {
    return this._suspendedAt;
  }

  /**
   * Suspends the account (request 34). Returns whether it changed: an account already suspended changes nothing and records
   * nothing. Records AccountSuspended otherwise.
   */
  suspend({ at }: { at: Date }): boolean {
    if (this.isSuspended) return false;
    this._suspendedAt = at;
    this.record(AccountSuspendedEvent.set({ accountId: this._id.value, suspendedAt: at.toISOString() }));
    return true;
  }

  /**
   * Reinstates the account (request 34). Returns whether it changed: an account that is not suspended changes nothing and records
   * nothing. Records AccountReinstated otherwise.
   */
  reinstate({ at }: { at: Date }): boolean {
    if (!this.isSuspended) return false;
    this._suspendedAt = null;
    this.record(AccountReinstatedEvent.set({ accountId: this._id.value, reinstatedAt: at.toISOString() }));
    return true;
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.email.value,
      name: this.name.value,
      passwordHash: this.passwordHash,
      version: this.version,
      suspendedAt: this._suspendedAt === null ? null : this._suspendedAt.toISOString(),
    };
  }
}
