/**
 * Issues the token a signed-in person sends with every request, and says which account a token proves.
 * A token proves its account without a record of its own: signing in records nothing (the storm).
 */
export interface ISessionTokens {
  issue(accountId: string): string;
  /** The account the token proves, or undefined when it proves none. */
  accountOf(token: string): string | undefined;
}
