import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';
import { ISettlementAudit } from '@Contexts/Ledger/Domain/Audit/Ports/ISettlementAudit';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * Ledger's SettlementAudit, answered over Settlements' read model (request 28, docs/adr/0027): the settlements' changes of money of a
 * group, translated here into Ledger's words.
 */
export class SettlementAuditOfSettlements implements ISettlementAudit {
  constructor(private readonly settlements: ISettlementQueries) {}

  async entriesOf(groupId: string): Promise<AuditEntryView[]> {
    const entries = await this.settlements.auditOf(groupId);
    return entries.map(({ id, at, by, action, subjectId, amount }) => ({ id, at, by, action, subjectId, amount }));
  }
}
