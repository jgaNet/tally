/** The token a signed-in person sends with every later request: who it names, until when. */
export interface ITokenIssuer {
  issue(accountId: string, now: Date): string;
  /** The id of the account the token names, or null when it proves nothing (forged, altered, expired). */
  verify(token: string, now: Date): string | null;
}
