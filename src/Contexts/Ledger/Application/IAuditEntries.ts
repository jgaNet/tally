import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The audit entries of Ledger's own changes (request 28): the expenses recorded, edited and deleted, kept in the Ledger file in the same
 * transaction as the expense they record, so an entry is there when its change is and never without it. Written by the use cases and
 * the policy on a day of a recurring expense; read by `GetGroupAudit`. An entry is never changed or removed.
 */
export interface IAuditEntries {
  /** Adds an entry of a group, in the transaction the change is made in. */
  add(groupId: string, entry: AuditEntry): Promise<void>;
  /** Moves every entry of a group merged into another to the group kept, each keeping its place in the order (request 31). */
  moveGroup(fromGroupId: string, toGroupId: string): Promise<void>;
  /** The entries of Ledger's own changes in a group, in the order they were written (the oldest first). */
  auditOf(groupId: string): Promise<AuditEntry[]>;
}
