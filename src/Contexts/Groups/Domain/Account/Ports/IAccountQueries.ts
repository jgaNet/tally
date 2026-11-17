import { Email } from '@SharedKernel/Domain';

/** What a signed-in person reads of their own account: who they are, as the groups show it. */
export interface AccountView {
  id: string;
  email: string;
  name: string;
}

/** What signing in needs to know: which account, and the hash its password must match. */
export interface AccountCredentials {
  id: string;
  passwordHash: string;
}

/**
 * The read side of accounts: read models, never aggregates (QUERY-READ-MODELS). Answers the screens and the
 * sign-in, reading what is kept now.
 */
export interface IAccountQueries {
  /** The account with this id, or null when there is none. */
  findAccount(id: string): Promise<AccountView | null>;
  /** The credentials of the account that uses this email, or null when no account does. */
  findCredentials(email: Email): Promise<AccountCredentials | null>;
}
