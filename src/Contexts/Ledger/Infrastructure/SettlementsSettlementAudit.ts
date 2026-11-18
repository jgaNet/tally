import { ISettlementAudit } from '@Contexts/Ledger/Application/Ports/ISettlementAudit';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { ISettlementAuditEntries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditEntries';

/**
 * Ledger's SettlementAudit, answered over Settlements' read side (request 28): the read Settlements' wiring exports, which
 * Ledger's wiring hands it. Ledger imports only the read's Domain port.
 */
export class SettlementsSettlementAudit implements ISettlementAudit {
  constructor(private readonly entries: ISettlementAuditEntries) {}

  entriesOf(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.entries.entriesOf(groupId);
  }
}
