/** The state of an account as the store keeps it: what `Account.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** Whether an administrator has suspended the account (request 34): a suspended account changes nothing until it is reinstated. */
  suspended: boolean;
  /** The version the account was read at: the store stores version + 1 on every save (ADR 0008). */
  version: number;
}

/**
 * One entry of the administrators' log about an account (request 34, docs/adr/0034): when (`at`), by which administrator (`by`, an account
 * id), what (`action`) and about which account (`subjectId`). Written with the change, in its transaction, and never changed.
 */
export interface AdministratorChange {
  id: string;
  at: string;
  by: string;
  action: 'suspended' | 'reinstated';
  subjectId: string;
}
