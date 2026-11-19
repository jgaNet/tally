/**
 * Issues the token a signed-in person sends with each request, and says which account a token names and in which role. A token is
 * signed, so it needs no row of its own, and it stays valid after the server is started again on the same file.
 */
export interface IAccessTokens {
  /** A token for the account, as an administrator when `administrator` (request 33), given at sign-in. */
  issue(accountId: string, administrator?: boolean): Promise<string>;
  /** The account a token names and whether it signed in as an administrator, or `undefined` when the token proves nothing. */
  accountOf(token: string): Promise<{ accountId: string; administrator: boolean } | undefined>;
}
