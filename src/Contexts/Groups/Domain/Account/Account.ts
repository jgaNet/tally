import { AggregateRoot, Id } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { AccountReinstatedEvent, AccountRegisteredEvent, AccountSuspendedEvent } from './AccountEvents';
import { AccountName } from './AccountName';

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
}

/**
 * One signed-in person, known by an email, with one name in every group (ADR 2). Its id is born here, once; its
 * rules are the decision's (`Account.decision.ts`), which checks what it is given before it is made. It carries the
 * version it was loaded at, and its repository refuses to save it over a newer one (CONC-OPTIMISTIC). It is suspended
 * by an administrator and reinstated by one, and nothing else changes it (request 34, ADR 32).
 */
export class Account extends AggregateRoot {
  readonly #email: Email;
  readonly #name: AccountName;
  readonly #passwordHash: string;
  #suspendedAt: Date | undefined;

  private constructor(
    id: Id,
    version: number,
    email: Email,
    name: AccountName,
    passwordHash: string,
    suspendedAt: Date | undefined,
  ) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
    this.#suspendedAt = suspendedAt;
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
    const account = new Account(Id.generate(), 0, email, name, passwordHash, undefined);
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
    return new Account(
      new Id(snapshot.id),
      snapshot.version ?? 0,
      email.data,
      name.data,
      snapshot.passwordHash,
      suspendedAt,
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

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email.value,
      name: this.#name.value,
      passwordHash: this.#passwordHash,
      version: this.version,
      ...(this.#suspendedAt === undefined ? {} : { suspendedAt: this.#suspendedAt.toISOString() }),
    };
  }
}
