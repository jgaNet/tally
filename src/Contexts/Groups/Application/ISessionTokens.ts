/**
 * Issues the token a signed-in person sends with each request, and says which account a token proves. Nothing is
 * recorded when a token is issued: a token proves itself, with the key the servers share (ADR 2).
 */
export interface ISessionTokens {
  issue(accountId: string): string;
  /** The account the token proves, or `undefined` when it proves nothing. */
  accountOf(token: string): string | undefined;
}
