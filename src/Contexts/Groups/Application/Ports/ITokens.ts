/** The token a signed-in person sends with every later request: it proves which account sent it. */
export interface ITokens {
  /** A token that proves the account of this id. */
  issue(accountId: string): string;
  /** The account id a token proves, or null for a token that proves nothing. */
  verify(token: string): string | null;
}
