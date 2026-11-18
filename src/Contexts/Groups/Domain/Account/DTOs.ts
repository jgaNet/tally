/** The plain shape of an account that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IAccountSnapshot {
  _id: string;
  /** The email the account signs in with; null once the account is deleted (request 35). */
  email: string | null;
  name: string;
  /** The hash of the password; empty once the account is deleted (request 35). */
  passwordHash: string;
  /** When the account was deleted, as an ISO 8601 string; null while it is not (request 35). */
  deletedAt: string | null;
  /** When the account was suspended, as an ISO 8601 string; null while it is not suspended (request 34). */
  suspendedAt: string | null;
  version: number;
}
