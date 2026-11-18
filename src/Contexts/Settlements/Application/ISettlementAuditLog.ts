import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';

/**
 * Settlements' audit (feature 28, ADR 23): the entry of a change of a settlement's money, written in the transaction of that change, so a change
 * answered as done has its entry and a change refused has none. Read through Settlements' read model (`ISettlementRoster.auditOf`).
 */
export interface ISettlementAuditLog {
  record(entry: SettlementAuditEntry): Promise<void>;
}
