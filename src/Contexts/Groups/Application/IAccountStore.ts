import { Account } from '@Contexts/Groups/Domain/Account/Account';

/** What a screen shows of one account: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** What a sign-in checks a password against: the account's id, and the hash the password port made. */
export interface AccountCredentials {
  readonly id: string;
  readonly passwordHash: string;
}

/**
 * The name a deleted account is shown by in every group it was a member of (feature 35, request 35): the member is still there, at their place,
 * and nobody's name is kept for them.
 */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/**
 * The store of accounts, the port the use cases write and read through. `emailTaken` and `credentialsOf` answer the facts
 * a rule needs about the collection, by the email as the shared kernel normalises it, whatever its case. `add` throws a
 * ConcurrencyConflictException when another write took the email first: the command re-reads and decides again (ADR 2).
 * A deleted account is none of the things a lookup finds (feature 35): it is not signed in to, not suspended, not viewed; the
 * members of a group name it through `memberName`, and the authentication asks `isDeleted`.
 */
export interface IAccountStore {
  emailTaken(email: string): Promise<boolean>;
  add(account: Account): Promise<void>;
  credentialsOf(email: string): Promise<AccountCredentials | undefined>;
  view(id: string): Promise<AccountView | undefined>;
  /** The account with this id, as the aggregate, or `undefined` when there is none (feature 34: an administrator suspends it). A deleted account is none. */
  find(id: string): Promise<Account | undefined>;
  /**
   * Saves the account at the version it was read at: a change another writer made first is a ConcurrencyConflictException, and the
   * command decides again on what it finds (CONC-OPTIMISTIC).
   */
  save(account: Account): Promise<void>;
  /** The name a member of a group is shown by: the account's name, or `Deleted account` once it is deleted (feature 35); `undefined` when there is no account. */
  memberName(id: string): Promise<string | undefined>;
  /** Whether the account with this id is deleted (feature 35): a token it had proves nothing then, and nobody signs in to it. */
  isDeleted(id: string): Promise<boolean>;
}
