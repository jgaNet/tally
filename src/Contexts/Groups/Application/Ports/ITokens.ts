import { Role } from '@SharedKernel/Domain';

/** What a token proves: the account it was issued to, and the role that account had when it signed in (request 33). */
export interface TokenClaims {
  accountId: string;
  role: Role;
}

/** The token a signed-in person sends with every later request: it proves which account sent it, and in which role. */
export interface ITokens {
  /** A token that proves the account of this id, in this role, given at sign-in. */
  issue(accountId: string, role: Role): string;
  /** What a token proves, or null for a token that proves nothing. A token issued before roles existed proves a user. */
  verify(token: string): TokenClaims | null;
}
