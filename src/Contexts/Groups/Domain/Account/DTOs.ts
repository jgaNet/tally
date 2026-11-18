/** The plain shape of an account that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IAccountSnapshot {
  _id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** When the account was suspended, as an ISO 8601 string; null while it is not suspended (request 34). */
  suspendedAt: string | null;
  version: number;
}
