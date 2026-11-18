import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import {
  AccountDeletedEvent,
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';
import {
  OwnsAGroupWithOtherMembers,
  PaymentWaitingAtTheProvider,
} from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { Name } from '@Contexts/Groups/Domain/Account/Name';

/** What the members list calls an account whose person deleted it (request 35): the name is erased, this is what is left to read. */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/**
 * One person: known by an email, with one name in every group, and a password they prove it with. An administrator may suspend it
 * (request 34): a suspended account is still signed in and reads everything, but the other contexts refuse what it starts until it is
 * reinstated. Its person may delete it (request 35): the email, the name and the password are erased, the id stays and means no one any
 * more, and the account is a placeholder in the groups it was a member of. Whether an email is already used is a fact about the collection, which the sign-up asks the repository for.
 */
export class Account extends AggregateRoot {
  private constructor(
    id: Id,
    public email: Email | null,
    public name: Name,
    public passwordHash: string,
    private suspendedAt: string | null,
    private deletedAt: string | null,
    version: number,
  ) {
    super(id, version);
  }

  static register({ email, name, passwordHash }: { email: Email; name: Name; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, null, null, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, name: name.value }));
    return account;
  }

  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const name = Name.create(snapshot.name);
    if (name.isFailure()) throw new Error(`The account ${snapshot.id} is corrupted`);
    if (snapshot.deletedAt !== null) {
      if (snapshot.email !== null) throw new Error(`The account ${snapshot.id} is corrupted`);
      return new Account(
        new Id(snapshot.id),
        null,
        name.data,
        '',
        snapshot.suspendedAt,
        snapshot.deletedAt,
        snapshot.version,
      );
    }
    const email = snapshot.email === null ? null : Email.create(snapshot.email);
    if (!email || email.isFailure() || !snapshot.passwordHash)
      throw new Error(`The account ${snapshot.id} is corrupted`);
    return new Account(
      new Id(snapshot.id),
      email.data,
      name.data,
      snapshot.passwordHash,
      snapshot.suspendedAt,
      null,
      snapshot.version,
    );
  }

  /** Whether its person deleted it (request 35). */
  isDeleted(): boolean {
    return this.deletedAt !== null;
  }

  /**
   * Deletes the account at `now`: its email, its name and its password are erased and it records that it happened. Refused while it owns a group
   * another member is in, or while a payment it pays or receives through the provider waits (`ownedWithOthers` and `paymentWaiting`, read by the
   * handler in its transaction); nothing changes then. An account deleted already is left as it is.
   */
  delete({
    ownedWithOthers,
    paymentWaiting,
    now,
  }: {
    ownedWithOthers: boolean;
    paymentWaiting: boolean;
    now: Date;
  }): IResult {
    if (this.isDeleted()) return Result.ok();
    if (ownedWithOthers) return Result.fail(new OwnsAGroupWithOtherMembers());
    if (paymentWaiting) return Result.fail(new PaymentWaitingAtTheProvider());
    this.email = null;
    this.name = Name.create(DELETED_ACCOUNT_NAME).data as Name;
    this.passwordHash = '';
    this.deletedAt = now.toISOString();
    this.record(AccountDeletedEvent.set({ accountId: this._id.value, at: this.deletedAt }));
    return Result.ok();
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
      email: this.email?.value ?? null,
      name: this.name.value,
      passwordHash: this.passwordHash,
      suspendedAt: this.suspendedAt,
      deletedAt: this.deletedAt,
      version: this.version,
    };
  }
}
