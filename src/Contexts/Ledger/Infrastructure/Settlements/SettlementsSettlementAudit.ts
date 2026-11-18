import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { ISettlementAudit } from '@Contexts/Ledger/Domain/Audit/Ports/ISettlementAudit';

/**
 * Ledger's port onto Settlements, answered over Settlements' read model (ADR 19): the settlements' audit entries, which
 * Settlements wrote in the transactions of its changes, read as Ledger's entries.
 */
export class SettlementsSettlementAudit implements ISettlementAudit {
  constructor(private settlements: ISettlementQueries) {}

  entriesOf(groupId: string): Promise<AuditEntry[]> {
    return this.settlements.auditOf(groupId);
  }
}
