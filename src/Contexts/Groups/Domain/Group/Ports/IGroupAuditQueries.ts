/** A balance a member passed to the owner when they left, as the group's audit shows it (request 28). */
export interface BalancePassedEntry {
  id: string;
  at: string;
  /** The member who left: the one the balance was theirs of. */
  by: string;
  action: 'balance-passed';
  subjectId: string;
  /** The balance as they left, positive or negative. */
  amount: number;
}

/**
 * The read-model port Ledger reads the balances passed through (request 28, ADR 19): every balance a member passed to the owner
 * when they left, the oldest first, for a group. Read by Ledger when it reads the group's audit, outside any transaction.
 */
export interface IGroupAuditQueries {
  balancesPassedIn(groupId: string): Promise<BalancePassedEntry[]>;
}
