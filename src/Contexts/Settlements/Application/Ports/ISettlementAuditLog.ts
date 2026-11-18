import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditQueries';

/**
 * Settlements' own audit of the money its settlements move (request 28): written in the transaction of the change, so the entry
 * is there when the change is answered, and never changed afterwards.
 */
export interface ISettlementAuditLog {
  record(groupId: string, entry: SettlementAuditEntry): Promise<void>;
}
