import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/** The expenses' entries of a group's audit, the oldest first: read by the audit query, outside any transaction. */
export interface IAuditQueries {
  entriesOf(groupId: string): Promise<AuditEntryReadModel[]>;
}
