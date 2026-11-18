/**
 * What a signed-in caller presents: a token that proves which account it is, given at sign-in. A technical
 * concern (how a proof is made), so it sits in the application, implemented in the infrastructure; the
 * domain only knows the account the proof names. Both answers are async: the key that signs them is kept in
 * the database, and is read the first time it is needed, once the database is open.
 */
export interface IAccessTokens {
  /** A token that proves the account with this id. */
  issue(accountId: string): Promise<string>;
  /** The id of the account the token proves, or null when it proves nothing (forged, altered, or not ours). */
  verify(token: string): Promise<string | null>;
}
