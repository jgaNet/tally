import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The audit of Ledger's own changes of money (feature 28, request 28), in Ledger's own table: an expense recorded, edited or deleted, and
 * the recurring expense's days recorded. `record` is written in the transaction of the change, so a change answered as done has its entry,
 * and a change refused has none; `entriesOf` answers the group's entries of this context, in the order they were written.
 */
export interface IAuditLog {
  record(entry: AuditEntry): Promise<void>;
  entriesOf(groupId: string): Promise<AuditEntry[]>;
}
