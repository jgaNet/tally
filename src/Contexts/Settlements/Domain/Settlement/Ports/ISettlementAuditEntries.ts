/**
 * A change of money a settlement made, as its history records it (request 28): `settlement-paid` when a settlement counts (in
 * cash when it is recorded, through the provider when the provider says it succeeded), `settlement-refunded` when a paid one
 * stops counting. `by` is the member the change acts for; `subjectId` is the settlement.
 */
export interface SettlementAuditRow {
  id: string;
  at: string;
  by: string;
  action: 'settlement-paid' | 'settlement-refunded';
  subjectId: string;
  amount: number;
}

/** Settlements' read of its changes of money, for the group's audit Ledger keeps (SettlementAudit, request 28). */
export interface ISettlementAuditEntries {
  entriesOf(groupId: string): Promise<SettlementAuditRow[]>;
}
