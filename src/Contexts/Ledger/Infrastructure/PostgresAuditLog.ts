import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAuditLog } from '@Contexts/Ledger/Application/IAuditLog';
import { AuditAction, AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * Ledger's audit table (feature 28, ADR 23): one row per change of money Ledger made, written in the change's transaction. `id` is the
 * change's own identity, so a change written twice meets the primary key and is refused. `seq` keeps the entries in the order they were
 * written, for the ones made at the same moment.
 */
export const auditTablesSchema = [
  `CREATE TABLE IF NOT EXISTS ledger_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     group_id TEXT NOT NULL REFERENCES groups(id),
     at TEXT NOT NULL,
     by_account_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('expense-recorded', 'expense-edited', 'expense-deleted')),
     subject_id TEXT NOT NULL,
     amount INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS ledger_audit_by_group ON ledger_audit (group_id, at, seq)',
];

interface AuditRow {
  id: string;
  group_id: string;
  at: string;
  by_account_id: string;
  action: AuditAction;
  subject_id: string;
  amount: number;
}

/** The audit of Ledger's changes in PostgreSQL (ADR 23): `record` writes an entry in the transaction of its change; `entriesOf` reads the group's. */
export class PostgresAuditLog implements IAuditLog {
  constructor(private readonly database: PostgresDatabase) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.database.writer
      .prepare(
        `INSERT INTO ledger_audit (id, group_id, at, by_account_id, action, subject_id, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount);
  }

  async entriesOf(groupId: string): Promise<AuditEntry[]> {
    const rows = (await this.database.read(db =>
      db.prepare('SELECT * FROM ledger_audit WHERE group_id = ? ORDER BY at, seq').all(groupId),
    )) as unknown as AuditRow[];
    return rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      at: row.at,
      by: row.by_account_id,
      action: row.action,
      subjectId: row.subject_id,
      amount: row.amount,
    }));
  }
}
