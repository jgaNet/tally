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
 * The store of accounts, the port the use cases write and read through. `emailTaken` and `credentialsOf` answer the facts
 * a rule needs about the collection, by the email as the shared kernel normalises it, whatever its case. `add` throws a
 * ConcurrencyConflictException when another write took the email first: the command re-reads and decides again (ADR 2).
 */
export interface IAccountStore {
  emailTaken(email: string): Promise<boolean>;
  add(account: Account): Promise<void>;
  credentialsOf(email: string): Promise<AccountCredentials | undefined>;
  view(id: string): Promise<AccountView | undefined>;
}
