import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';
import { Email, Role } from '@SharedKernel/Domain';

import { EmailAlreadyRegisteredException } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { Password } from '@Contexts/Groups/Domain/Account/Password';

/**
 * An account, as the domain keeps it: one signed-in person, known by an email, with one name in every group
 * (conventions/domain.yaml). Its password is kept as the hash the password port made, never as typed (ADR 3).
 */
export class Account extends AggregateRoot {
  readonly #email: string;
  readonly #name: string;
  readonly #passwordHash: string;

  private constructor(id: Id, email: string, name: string, passwordHash: string, version: number) {
    super(id, version);
    this.#email = email;
    this.#name = name;
    this.#passwordHash = passwordHash;
  }

  /**
   * A sign-up: the email must look like one and be unused, the password have 8 characters at least, the name be 1 to 60
   * characters and not only spaces. The identity is generated here (DOMAIN-IDENTITY), and the creation records
   * AccountRegistered. Pure: the time is `now`, the hash is given, and `emailTaken` is the fact the store answers.
   */
  static create(
    { email, password, passwordHash, name }: Registration,
    { emailTaken }: RegistrationFacts,
    now: Date,
  ): IResult<Account> {
    const normal = Email.create(email);
    if (normal.isFailure()) return Result.fail(normal.error);

    const typed = Password.create(password);
    if (typed.isFailure()) return Result.fail(typed.error);

    const displayName = AccountName.create(name);
    if (displayName.isFailure()) return Result.fail(displayName.error);

    if (emailTaken) return Result.fail(new EmailAlreadyRegisteredException());

    const id = Id.generate();
    const account = new Account(id, normal.data.value, displayName.data.value, passwordHash, 0);
    account.record(AccountRegisteredEvent.set({ accountId: id.value, at: now.toISOString() }));
    return Result.ok(account);
  }

  /**
   * The role an account has when it signs in (request 33): an administrator is an account whose email is one of the administrators'
   * emails, whatever its case, and every other account is a user. Pure: the list is the one the server was started with (ADMIN_EMAILS).
   */
  static roleFor(email: string, administrators: readonly string[]): Role {
    const normal = email.trim().toLowerCase();
    return administrators.some(administrator => administrator.trim().toLowerCase() === normal) ? Role.ADMIN : Role.USER;
  }

  /** The account as the store keeps it. Records nothing. */
  static fromSnapshot(snapshot: AccountSnapshot): Account {
    const email = Email.create(snapshot.email);
    const name = AccountName.create(snapshot.name);
    if (email.isFailure() || name.isFailure()) {
      throw new Error(`The account ${snapshot.id} is corrupted: it does not hold a valid email or name`);
    }
    return new Account(new Id(snapshot.id), email.data.value, name.data.value, snapshot.passwordHash, snapshot.version);
  }

  toSnapshot(): AccountSnapshot {
    return {
      id: this._id.value,
      email: this.#email,
      name: this.#name,
      passwordHash: this.#passwordHash,
      version: this.version,
    };
  }
}

/** What a sign-up gives the aggregate: the typed values, and the hash the password port made of the password. */
export interface Registration {
  readonly email: string;
  readonly password: string;
  readonly passwordHash: string;
  readonly name: string;
}

/** What the store says about the collection: whether the email is already used (a fact a rule needs). */
export interface RegistrationFacts {
  readonly emailTaken: boolean;
}

/** An account as the store keeps it, its version included. */
export interface AccountSnapshot {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly version: number;
}

export type AccountRegisteredPayload = { accountId: string; at: string };

/**
 * The fact of a sign-up (ADR 3), recorded by the creation of the account with its id and the time. It is made durable
 * with the account and published after the commit; nothing subscribes to it yet.
 */
export class AccountRegisteredEvent extends DomainEvent<AccountRegisteredPayload> {}
