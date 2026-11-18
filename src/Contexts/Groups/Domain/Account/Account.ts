import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import {
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
import { Name } from '@Contexts/Groups/Domain/Account/Name';

/**
 * One person: known by an email, with one name in every group, and a password they prove it with. An administrator may suspend it
 * (request 34): a suspended account is still signed in and reads everything, but the other contexts refuse what it starts until it is
 * reinstated. Whether an email is already used is a fact about the collection, which the sign-up asks the repository for.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    readonly email: Email,
    readonly name: Name,
    readonly passwordHash: string,
    private suspendedAt: string | null,
    version: number,
  ) {
    super(id, version);
  }

  static register({ email, name, passwordHash }: { email: Email; name: Name; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, null, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = Name.create(snapshot.name);
    if (email.isFailure() || name.isFailure() || !snapshot.passwordHash) {
      throw new Error(`The account ${snapshot.id} is corrupted`);
    }
    return new Account(
      new Id(snapshot.id),
      email.data,
      name.data,
      snapshot.passwordHash,
      snapshot.suspendedAt,
      snapshot.version,
    );
  }

  /** Whether an administrator has suspended the account and not reinstated it since (request 34). */
  isSuspended(): boolean {
    return this.suspendedAt !== null;
  }

  /**
   * Suspends the account at `now`, and records it; an account suspended already is left as it is, and records nothing. Returns whether it
   * changed, so the handler writes the administrators' log once per change (request 34).
   */
  suspend(now: Date): boolean {
    if (this.isSuspended()) return false;
    this.suspendedAt = now.toISOString();
    this.record(AccountSuspendedEvent.set({ accountId: this._id.value, at: this.suspendedAt }));
    return true;
  }

  /** Reinstates the account at `now`, and records it; an account that is not suspended is left as it is. Returns whether it changed. */
  reinstate(now: Date): boolean {
    if (!this.isSuspended()) return false;
    this.suspendedAt = null;
    this.record(AccountReinstatedEvent.set({ accountId: this._id.value, at: now.toISOString() }));
    return true;
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.email.value,
      name: this.name.value,
      passwordHash: this.passwordHash,
      suspendedAt: this.suspendedAt,
      version: this.version,
    };
  }
}
