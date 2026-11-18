import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/** The read side of the audit: the entries of Ledger's own changes of money, read model only (QUERY-READ-MODELS). */
export interface IAuditQueries {
  /** The entries of the expenses of the group, in the order they were written. */
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
