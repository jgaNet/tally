import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/**
 * Ledger's own audit of the expenses' money (request 28): an entry is written in the transaction of the change it records, so it is
 * there when the change is answered. Never changed afterwards.
 */
export interface IAuditLog {
  record(groupId: string, entry: AuditEntryReadModel): Promise<void>;
}
