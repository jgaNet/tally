/**
 * Issues the token a signed-in person sends with each request, and says which account a token names. A token is
 * signed, so it needs no row of its own, and it stays valid after the server is started again on the same file.
 */
export interface IAccessTokens {
  issue(accountId: string): Promise<string>;
  /** The account a token names, or `undefined` when the token proves nothing. */
  accountOf(token: string): Promise<string | undefined>;
}
