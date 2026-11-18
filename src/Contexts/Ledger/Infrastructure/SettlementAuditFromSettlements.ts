import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { ISettlementAudit } from '@Contexts/Ledger/Application/Ports/ISettlementAudit';
import { ISettlementAuditQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditQueries';

/**
 * Ledger's port to Settlements, answered over Settlements' read model (ADR 19): the money the group's settlements moved, read when the
 * audit is read. The read model is a function, the one Settlements' wiring exports, because the two wiring files import each other
 * (ADR 4): it is read when the entries are asked.
 */
export class SettlementAuditFromSettlements implements ISettlementAudit {
  constructor(private settlements: () => ISettlementAuditQueries) {}

  async entriesOf(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.settlements().entriesOf(groupId);
  }
}
