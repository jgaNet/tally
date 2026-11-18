import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * Ledger's own port onto Settlements: the audit entries of the settlements of a group, the changes of money Settlements
 * writes (request 28, ADR 19). The adapter answers over Settlements' read model; no domain imports Settlements.
 */
export interface ISettlementAudit {
  /** The entries of the group's settlements, in the order they were written. */
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
