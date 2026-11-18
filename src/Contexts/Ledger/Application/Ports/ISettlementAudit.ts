import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * Ledger's SettlementAudit (request 28): the changes of money the settlements of a group made, when the provider or the payee
 * said so. Ledger owns the port and asks it for the group's audit; its adapter answers it over Settlements' read side.
 */
export interface ISettlementAudit {
  entriesOf(groupId: string): Promise<AuditEntryReadModel[]>;
}
