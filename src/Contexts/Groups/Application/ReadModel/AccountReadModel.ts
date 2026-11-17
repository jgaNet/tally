/** What a signed-in person reads of their own account. */
export interface AccountReadModel {
  id: string;
  email: string;
  name: string;
}

/** What signing in checks: the account's id and the hash its password must match. */
export interface AccountCredentials {
  id: string;
  passwordHash: string;
}
