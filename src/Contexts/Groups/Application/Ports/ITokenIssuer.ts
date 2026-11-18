import { Role } from '@SharedKernel/Domain';

/** The token a signed-in person sends with every later request: who it names, the role given at sign-in, until when. */
export interface ITokenIssuer {
  issue(accountId: string, role: Role, now: Date): string;
  /** Who the token names and in which role, or null when it proves nothing (forged, altered, expired). */
  verify(token: string, now: Date): { accountId: string; role: Role } | null;
}
