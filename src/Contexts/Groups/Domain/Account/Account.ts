import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import {
  AccountDeletedEvent,
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from './AccountEvents';
import { AccountName } from './AccountName';

/** The name a deleted account is shown by in every group (request 35): the members list names it so. */
export const DELETED_NAME = 'Deleted account';

/** The password hash a deleted account keeps: it is none that any password matches, so nobody signs in with it (request 35). */
export const DELETED_PASSWORD_HASH = 'deleted';

/**
 * The email a deleted account keeps: one only its id makes, in the reserved `.invalid` domain (RFC 2606), so it is unique as the email was and is
 * no one's (request 35). A new account may use the email the deleted one had, which is someone else.
 */
const tombstoneEmailOf = (accountId: string): Email => {
  const email = Email.create(`${accountId}@deleted.invalid`);
  if (email.isFailure()) throw new Error(`The id ${accountId} makes no tombstone email`);
  return email.data;
};

/** An account as it is stored: its email normalised, its name trimmed, its password as a hash, and whether it is suspended (request 34). */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** The version it was read at (CONC-OPTIMISTIC); an account stored before versions were kept reads as 0. */
  version?: number;
  /** When an administrator suspended it, while it is suspended; absent otherwise. */
  suspendedAt?: string;
  /** When the person deleted it (request 35): from then on its name and email are erased, and it signs in nowhere; absent otherwise. */
  deletedAt?: string;
}

/**
 * One signed-in person, known by an email, with one name in every group (ADR 2). Its id is born here, once; its
 * rules are the decision's (`Account.decision.ts`), which checks what it is given before it is made. It carries the
 * version it was loaded at, and its repository refuses to save it over a newer one (CONC-OPTIMISTIC). It is suspended
 * by an administrator and reinstated by one, and nothing else changes it (request 34, ADR 32).
 */
export class Account extends AggregateRoot {
  #email: Email;
  #name: AccountName;
  #passwordHash: string;
  #suspendedAt: Date | undefined;
  #deletedAt: Date | undefined;

  private constructor(
    id: Id,
    version: number,
    email: Email,
    name: AccountName,
    passwordHash: string,
    suspendedAt: Date | undefined,
    deletedAt: Date | undefined,
  ) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
    this.#suspendedAt = suspendedAt;
    this.#deletedAt = deletedAt;
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
    const account = new Account(Id.generate(), 0, email, name, passwordHash, undefined, undefined);
    account.record(AccountRegisteredEvent.set({ accountId: account._id.value, registeredAt: at }));
    return account;
  }

  /** Rebuilds an account from what was stored, at the version it was stored at. It records nothing, and throws on corrupted data. */
  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    if (email.isFailure()) throw new Error(`Corrupted account ${snapshot.id}: its email is not one`);
    const name = AccountName.create(snapshot.name);
    if (name.isFailure()) throw new Error(`Corrupted account ${snapshot.id}: its name is not one`);
    if (!snapshot.passwordHash) throw new Error(`Corrupted account ${snapshot.id}: it has no password`);
    const suspendedAt = snapshot.suspendedAt === undefined ? undefined : new Date(snapshot.suspendedAt);
    if (suspendedAt !== undefined && Number.isNaN(suspendedAt.getTime())) {
      throw new Error(`Corrupted account ${snapshot.id}: its suspension is not a time`);
    }
    const deletedAt = snapshot.deletedAt === undefined ? undefined : new Date(snapshot.deletedAt);
    if (deletedAt !== undefined && Number.isNaN(deletedAt.getTime())) {
      throw new Error(`Corrupted account ${snapshot.id}: its deletion is not a time`);
    }
    return new Account(
      new Id(snapshot.id),
      snapshot.version ?? 0,
      email.data,
      name.data,
      snapshot.passwordHash,
      suspendedAt,
      deletedAt,
    );
  }

  /**
   * The administrator suspends the account at `at` (request 34): from then on it may not record an expense, set up a recurring expense, record
   * a settlement in cash, ask to pay through the provider or ask for a netting, in any group. Recorded as `AccountSuspended`, published after its
   * save. Whether it changes anything is the decision's to say (`decideSuspendAccount`), before this is called.
   */
  suspend(at: Date): void {
    this.#suspendedAt = at;
    this.record(AccountSuspendedEvent.set({ accountId: this._id.value, suspendedAt: at }));
  }

  /** The administrator reinstates the account at `at` (request 34). Recorded as `AccountReinstated`, published after its save. */
  reinstate(at: Date): void {
    this.#suspendedAt = undefined;
    this.record(AccountReinstatedEvent.set({ accountId: this._id.value, reinstatedAt: at }));
  }

  /**
   * The person deletes the account at `at` (request 35): its name and its email are erased and replaced by what stands for no one, its password
   * is no longer one it can be signed in with, and it is deleted for good. Its id stays where it is: in the groups' members, the expenses, the
   * settlements and the audit, which mean no one any more. Recorded as `AccountDeleted`, published after its save; whether a deletion is allowed is
   * the decision's to say (`decideDeleteAccount`), before this is called.
   */
  delete(at: Date): void {
    this.#email = tombstoneEmailOf(this._id.value);
    this.#name = AccountName.create(DELETED_NAME).data as AccountName;
    this.#passwordHash = DELETED_PASSWORD_HASH;
    this.#deletedAt = at;
    this.record(AccountDeletedEvent.set({ accountId: this._id.value, deletedAt: at }));
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

  /** Whether an administrator suspended the account and has not reinstated it since (request 34). */
  get isSuspended(): boolean {
    return this.#suspendedAt !== undefined;
  }

  /** Whether the person deleted the account (request 35): its name and email are erased, and it signs in nowhere. */
  get isDeleted(): boolean {
    return this.#deletedAt !== undefined;
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      version: this.version,
      ...(this.#suspendedAt === undefined ? {} : { suspendedAt: this.#suspendedAt.toISOString() }),
      ...(this.#deletedAt === undefined ? {} : { deletedAt: this.#deletedAt.toISOString() }),
    };
  }
}
