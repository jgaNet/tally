/** What signing in checks a password against. It is never answered to a client. */
export interface CredentialsReadModel {
  accountId: string;
  passwordHash: string;
}
