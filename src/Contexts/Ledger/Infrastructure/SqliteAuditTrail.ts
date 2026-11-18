import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { AuditEntryDraft, IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';
import { AUDIT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/audit.schema';

/** Writes an expense's change to the audit, inside the command's transaction, which holds the connection (request 28). */
export class SqliteAuditTrail implements IAuditTrail {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(AUDIT_STATEMENTS);
  }

  async record(entry: AuditEntryDraft): Promise<void> {
    this.database.connection
      .prepare(
        'INSERT INTO ledger_audit_entries (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.groupId, entry.at.toISOString(), entry.by, entry.action, entry.subjectId, entry.amount);
  }
}
