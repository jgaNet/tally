/** A change of money a settlement made, as the group's audit shows it (request 28). */
export interface SettlementAuditEntry {
  id: string;
  at: string;
  by: string;
  /** `settlement-paid` when the balances start to count the settlement, `settlement-refunded` when they stop counting it. */
  action: 'settlement-paid' | 'settlement-refunded';
  subjectId: string;
  amount: number;
}

/**
 * The read-model port another context reads a group's money changes through (ADR 19): every settlement paid or refunded in the
 * group, the oldest first. Ledger reads it when it reads the group's audit, outside any transaction, so it takes no lock of its own.
 */
export interface ISettlementAuditQueries {
  entriesOf(groupId: string): Promise<SettlementAuditEntry[]>;
}
