import { AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';

/** The read side of Ledger's own audit: the entries of the expenses of a group, as they were written (request 28, docs/adr/0027). */
export interface IAuditQueries {
  /** The expense entries of the group, the oldest first. */
  entriesOf(groupId: string): Promise<AuditEntryView[]>;
}
