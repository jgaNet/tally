import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The entries of the settlements of a group, as Ledger's audit reads them (feature 28, ADR 23): a port Ledger owns, in its own words,
 * answered over Settlements' read model. Each entry is a settlement paid or refunded, as Settlements wrote it in the transaction of that
 * change. The adapter is Ledger's infrastructure over Settlements' roster, so no domain imports Settlements.
 */
export interface ISettlementAudit {
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
