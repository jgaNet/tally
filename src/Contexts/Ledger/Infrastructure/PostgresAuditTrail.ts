import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { AuditEntryDraft, IAuditTrail } from '@Contexts/Ledger/Application/Ports/IAuditTrail';
import { AUDIT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/audit.schema';

/** Writes an expense's change to the audit, inside the command's transaction, which holds the connection (request 28). */
export class PostgresAuditTrail implements IAuditTrail {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(AUDIT_STATEMENTS);
  }

  async record(entry: AuditEntryDraft): Promise<void> {
    await this.database.connection.run(
      'INSERT INTO ledger_audit_entries (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id,
      entry.groupId,
      entry.at.toISOString(),
      entry.by,
      entry.action,
      entry.subjectId,
      entry.amount,
    );
  }
}
