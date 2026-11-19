import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountOwnsAGroupWithMembers } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { PaymentWaitingAtProvider } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import {
  AccountDeletedEvent,
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
/** What the members' list names an account whose person deleted it (request 35). */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/**
 * An account: who a person is to the others, one email, one name in every group. It is made by
 * `register()`, which records the fact; the password is known only by its hash, which a port
 * computed and this class keeps as it was given. An administrator may suspend it and reinstate it (request 34):
 * a suspended account starts nothing that records money, in any group, until it is reinstated, and nothing in a group changes.
 * A person may delete it (request 35): its email and its password are erased, its name becomes `Deleted account`, and its id stays
 * where it is, naming no one.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    private _email: Email | null,
    private _name: AccountName,
    private _passwordHash: string,
    private _suspendedAt: Date | null = null,
    private _deletedAt: Date | null = null,
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
    const suspendedAt = snapshot.suspendedAt ? new Date(snapshot.suspendedAt) : null;
    if (snapshot.deletedAt) {
      const name = AccountName.create(DELETED_ACCOUNT_NAME);
      if (!snapshot.id || name.isFailure()) throw new Error(`Corrupted account ${snapshot.id}`);
      return new Account(
        new Id(snapshot.id),
        snapshot.version,
        null,
        name.data,
        '',
        suspendedAt,
        new Date(snapshot.deletedAt),
      );
    }
    const email = snapshot.email === null ? null : Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email === null || email.isFailure() || name.isFailure() || !snapshot.id || !snapshot.passwordHash) {
      throw new Error(`Corrupted account ${snapshot.id}`);
    }
    return new Account(
      new Id(snapshot.id),
      snapshot.version,
      email.data,
      name.data,
      snapshot.passwordHash,
      suspendedAt,
    );
  }

  /** Its email, null once it is deleted (request 35). */
  get email(): Email | null {
    return this._email;
  }

  /** Its name: what the others read of it, `Deleted account` once it is deleted. */
  get name(): AccountName {
    return this._name;
  }

  /** The hash of its password, empty once it is deleted: nothing signs in to it. */
  get passwordHash(): string {
    return this._passwordHash;
  }

  /** Whether its person deleted it (request 35): it is no one any more, and stays a member where it was. */
  get isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  /** The moment it was deleted, null while it is not. */
  get deletedAt(): Date | null {
    return this._deletedAt;
  }

  /**
   * Deletes the account (request 35): its name, its email and its password are erased, and nothing else changes. Refused, and
   * nothing changes, while it owns a group that has another member (`ownsAGroupWithMembers`) or a payment of it waits at the
   * provider (`paymentWaiting`, pending, refunding or contested). An account already deleted changes nothing and records
   * nothing. Records AccountDeleted otherwise.
   */
  delete({
    at,
    ownsAGroupWithMembers,
    paymentWaiting,
  }: {
    at: Date;
    ownsAGroupWithMembers: boolean;
    paymentWaiting: boolean;
  }): IResult<undefined> {
    if (this.isDeleted) return Result.ok(undefined);
    if (ownsAGroupWithMembers) return Result.fail(new AccountOwnsAGroupWithMembers());
    if (paymentWaiting) {
      return Result.fail(
        new PaymentWaitingAtProvider('An account is deleted once no payment of it waits at the provider'),
      );
    }
    const erased = AccountName.create(DELETED_ACCOUNT_NAME);
    if (erased.isFailure()) throw new Error('The name of a deleted account is valid');
    this._email = null;
    this._name = erased.data;
    this._passwordHash = '';
    this._deletedAt = at;
    this.record(AccountDeletedEvent.set({ accountId: this._id.value, deletedAt: at.toISOString() }));
    return Result.ok(undefined);
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
      email: this._email === null ? null : this._email.value,
      name: this._name.value,
      passwordHash: this._passwordHash,
      version: this.version,
      suspendedAt: this._suspendedAt === null ? null : this._suspendedAt.toISOString(),
      deletedAt: this._deletedAt === null ? null : this._deletedAt.toISOString(),
    };
  }
}
