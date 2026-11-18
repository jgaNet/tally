import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { ISettlementAudit } from '@Contexts/Ledger/Application/ISettlementAudit';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';

/**
 * Answers Ledger's `ISettlementAudit` port over Settlements' read model (CTX-CONTRACTS, ADR 25): the changes of money the group's settlements
 * made, in Ledger's words. It is the one place Ledger reads Settlements' audit, and only the read model's `auditOf`; Ledger's Domain never
 * imports Settlements. The read model is given as a function, read at a request and not when the modules are built (ADR 7).
 */
export class SettlementAuditOfSettlements implements ISettlementAudit {
  constructor(private readonly settlements: () => Pick<ISettlementQueries, 'auditOf'>) {}

  async auditOf(groupId: string): Promise<AuditEntry[]> {
    return (await this.settlements().auditOf(groupId)).map(line => ({
      id: line.id,
      at: line.at,
      by: line.by,
      action: line.action,
      subjectId: line.subjectId,
      amount: line.amount,
    }));
  }
}
