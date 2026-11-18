import { Role } from '@SharedKernel/Domain';

/**
 * Issues the token a signed-in person sends with every request, and says which account a token proves, and the role it had when it
 * signed in (docs/adr/0033). A token proves its account without a record of its own: signing in records nothing (the storm).
 */
export interface ISessionTokens {
  issue(accountId: string, role: Role): string;
  /** The account the token proves and its role, or undefined when it proves none. */
  accountOf(token: string): { subjectId: string; role: Role } | undefined;
}
