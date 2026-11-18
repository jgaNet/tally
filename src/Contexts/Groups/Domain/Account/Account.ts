import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { IAccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import {
  DeletionPaymentWaitingException,
  OwnsGroupWithMembersException,
} from '@Contexts/Groups/Domain/Account/AccountExceptions';
import {
  AccountDeletedEvent,
  AccountRegisteredEvent,
  AccountReinstatedEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

/** The name a deleted account is known by in every group it is in (request 35): the one its name is erased to. */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/**
 * Account is the aggregate root of Groups' accounts: one person who signs in, known by an email, with the
 * one name every group they are in shows (ADR 1). Its name and email are value objects, so an account once
 * held is valid; the hash it keeps is the hasher's, of a password the registration validated.
 *
 * The email must be unique across accounts. That rule spans the whole collection, so it lives in the
 * AccountRegistration domain service, not here. A sign-in records nothing. An administrator suspends an account and
 * reinstates it (request 34): the suspension is the one state an account changes in, and it is decided here, once.
 *
 * The person deletes their account (request 35): its email and its password are erased, its name becomes DELETED_ACCOUNT_NAME,
 * and its id stays, in every group it is in, as the one of a person who is no longer. The deletion is refused while the account owns
 * a group that has another member, and while a payment through the provider it pays or receives has not ended. Once deleted, the
 * account is nobody: nothing signs it in, and no new change is made by it or with it.
 */
export class Account extends AggregateRoot {
  #email: Email | null;
  #name: AccountName;
  #passwordHash: string;
  #suspendedAt: string | null;
  #deletedAt: string | null;

  private constructor(
    id: Id,
    email: Email | null,
    name: AccountName,
    passwordHash: string,
    suspendedAt: string | null,
    deletedAt: string | null,
    version: number,
  ) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
    this.#suspendedAt = suspendedAt;
    this.#deletedAt = deletedAt;
  }

  /** Opens a new account: its id is generated here, and the creation is recorded. */
  static create({ email, name, passwordHash }: { email: Email; name: AccountName; passwordHash: string }): Account {
    const account = new Account(Id.generate(), email, name, passwordHash, null, null, 0);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value }));
    return account;
  }

  /** Rebuilds an account from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IAccountSnapshot): Account {
    const name = AccountName.create(snapshot.name);
    if (name.isFailure()) throw new Error(`Corrupted account ${snapshot._id}`);

    if (snapshot.deletedAt !== null) {
      return new Account(
        new Id(snapshot._id),
        null,
        name.data,
        '',
        snapshot.suspendedAt,
        snapshot.deletedAt,
        snapshot.version,
      );
    }

    const email = snapshot.email === null ? null : Email.create(snapshot.email);
    if (email === null || email.isFailure() || !snapshot.passwordHash) {
      throw new Error(`Corrupted account ${snapshot._id}`);
    }
    return new Account(
      new Id(snapshot._id),
      email.data,
      name.data,
      snapshot.passwordHash,
      snapshot.suspendedAt,
      null,
      snapshot.version,
    );
  }

  /**
   * Suspends the account at the time given (request 34), recording AccountSuspended. An account already suspended changes
   * nothing: it records nothing, and the answer is false. The answer is true when this suspended it. A deleted account is not
   * suspended: it changes nothing either.
   */
  suspend(at: Date): boolean {
    if (this.#suspendedAt !== null || this.#deletedAt !== null) return false;
    this.#suspendedAt = at.toISOString();
    this.record(AccountSuspendedEvent.set({ accountId: this._id.value, suspendedAt: this.#suspendedAt }));
    return true;
  }

  /**
   * Reinstates the account at the time given (request 34), recording AccountReinstated. An account not suspended changes
   * nothing: it records nothing, and the answer is false. The answer is true when this reinstated it.
   */
  reinstate(at: Date): boolean {
    if (this.#suspendedAt === null) return false;
    this.#suspendedAt = null;
    this.record(AccountReinstatedEvent.set({ accountId: this._id.value, reinstatedAt: at.toISOString() }));
    return true;
  }

  /**
   * Deletes the account at the time given (request 35), recording AccountDeleted. The caller reads, through its ports, whether the
   * account owns a group that has another member and whether a payment through the provider it pays or receives has not ended; both
   * refuse the deletion, and nothing changes. Otherwise the email and the password are erased, the name becomes DELETED_ACCOUNT_NAME,
   * and the id is kept. An account already deleted is not found.
   */
  delete({
    at,
    ownsGroupWithMembers,
    paymentOpen,
  }: {
    at: Date;
    ownsGroupWithMembers: boolean;
    paymentOpen: boolean;
  }): IResult<void> {
    if (this.#deletedAt !== null) return Result.fail(new NotFoundException('Groups', 'Account not found'));
    if (ownsGroupWithMembers) return Result.fail(new OwnsGroupWithMembersException());
    if (paymentOpen) return Result.fail(new DeletionPaymentWaitingException());

    const erased = AccountName.create(DELETED_ACCOUNT_NAME);
    if (erased.isFailure()) return Result.fail(erased.error);

    this.#email = null;
    this.#passwordHash = '';
    this.#name = erased.data;
    this.#deletedAt = at.toISOString();
    this.record(AccountDeletedEvent.set({ accountId: this._id.value, deletedAt: this.#deletedAt }));
    return Result.ok();
  }

  toSnapshot(): IAccountSnapshot {
    return {
      _id: this._id.value,
      email: this.#email?.value ?? null,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      deletedAt: this.#deletedAt,
      suspendedAt: this.#suspendedAt,
      version: this.version,
    };
  }

  /** The email the account signs in with; null once the account is deleted (request 35). */
  get email(): Email | null {
    return this.#email;
  }

  get name(): AccountName {
    return this.#name;
  }

  get passwordHash(): string {
    return this.#passwordHash;
  }

  /** Whether the account is suspended: true from its suspension until its reinstatement (request 34). */
  get isSuspended(): boolean {
    return this.#suspendedAt !== null;
  }

  /** Whether the account is deleted: true from its deletion on, for good (request 35). */
  get isDeleted(): boolean {
    return this.#deletedAt !== null;
  }
}
