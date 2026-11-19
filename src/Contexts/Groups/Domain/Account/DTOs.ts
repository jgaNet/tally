/** The state of an account as the store keeps it: what `Account.fromSnapshot()` reads and `toSnapshot()` writes. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  /** Whether an administrator has suspended the account (request 34): a suspended account changes nothing until it is reinstated. */
  suspended: boolean;
  /**
   * Whether the person deleted the account (request 35, docs/adr/0035): its name and email are erased, and it signs in and proves nothing
   * any more. Its id stays where it is, in the groups, the expenses, the settlements and the audit.
   */
  deleted: boolean;
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
