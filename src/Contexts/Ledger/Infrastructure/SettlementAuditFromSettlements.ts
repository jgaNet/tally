import { ISettlementRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';
import { ISettlementAudit } from '@Contexts/Ledger/Application/ISettlementAudit';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/** Settlements' read model of its audit entries, as Settlements gives it to the other contexts: the type the wiring is given. */
export type SettlementAuditRoster = ISettlementRoster;

/**
 * The settlements' audit entries of a group, answered over Settlements' read model (feature 28, ADR 23): Ledger's port `ISettlementAudit`
 * is built on the roster Settlements gives, so the audit reads what Settlements wrote, and no domain imports Settlements.
 */
export class SettlementAuditFromSettlements implements ISettlementAudit {
  constructor(private readonly roster: SettlementAuditRoster) {}

  async entriesOf(groupId: string): Promise<AuditEntry[]> {
    return this.roster.auditOf(groupId);
  }
}
