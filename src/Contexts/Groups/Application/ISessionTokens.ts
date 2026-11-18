import { Role } from '@SharedKernel/Domain';

/**
 * Issues the token a signed-in person sends with each request, and says which account a token proves, and with which role (request 33:
 * an administrator's token says so, given at sign-in). Nothing is recorded when a token is issued: a token proves itself, with the key the
 * servers share (ADR 2).
 */
export interface ISessionTokens {
  issue(accountId: string, role?: Role): string;
  /** The account the token proves, or `undefined` when it proves nothing. */
  accountOf(token: string): string | undefined;
  /** The role the token proves: a user's unless the sign-in gave an administrator's (request 33). */
  roleOf(token: string): Role;
}
