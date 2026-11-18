import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';

/** Ledger's own entries of a group's audit, read outside any transaction (request 28). */
export interface IAuditQueries {
  listByGroup(groupId: string): Promise<AuditEntryReadModel[]>;
}
