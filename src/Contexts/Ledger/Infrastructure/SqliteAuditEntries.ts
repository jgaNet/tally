import { AuditAction, AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { IAuditEntries } from '@Contexts/Ledger/Application/IAuditEntries';

import { LedgerDatabase } from './LedgerDatabase';

type AuditRow = { id: string; at: string; by_account: string; action: AuditAction; subject_id: string; amount: number };

/**
 * The audit entries of Ledger's own changes in PostgreSQL (request 28), in the Ledger tables beside the expenses they record: an entry is written in the
 * transaction of its change, so it is there exactly when the change is. Nothing updates or deletes a row: an entry stays when its expense is
 * deleted.
 */
export class SqliteAuditEntries implements IAuditEntries {
  constructor(private readonly database: LedgerDatabase) {}

  async add(groupId: string, entry: AuditEntry): Promise<void> {
    await this.database.execute(
      'INSERT INTO ledger_audit_entries (id, group_id, at, by_account, action, subject_id, amount) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [entry.id, groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount],
    );
  }

  async auditOf(groupId: string): Promise<AuditEntry[]> {
    const rows = await this.database.rows<AuditRow>(
      'SELECT id, at, by_account, action, subject_id, amount FROM ledger_audit_entries WHERE group_id = $1 ORDER BY seq',
      [groupId],
    );
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_account,
      action: row.action,
      subjectId: row.subject_id,
      amount: row.amount,
    }));
  }
}
