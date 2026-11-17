/** The state of an account as the store keeps it: what `Account.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** The version the account was read at: the store stores version + 1 on every save (ADR 0008). */
  version: number;
}
