import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * Ledger's port to Settlements, which Ledger owns (ADR 19): the money the group's settlements moved, read when the group's audit is
 * read, so that every change of money is in the audit with no copy of it here. Answered by an adapter over Settlements' read model.
 */
export interface ISettlementAudit {
  entriesOf(groupId: string): Promise<AuditEntryReadModel[]>;
}
