/**
 * What a signed-in caller presents: a token that proves which account it is, given at sign-in. A technical
 * concern (how a proof is made), so it sits in the application, implemented in the infrastructure; the
 * domain only knows the account the proof names.
 */
export interface IAccessTokens {
  /** A token that proves the account with this id. */
  issue(accountId: string): string;
  /** The id of the account the token proves, or null when it proves nothing (forged, altered, or not ours). */
  verify(token: string): string | null;
}
