import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IGroupAuditLog } from '@Contexts/Groups/Application/IGroupAuditLog';
import { GroupAuditEntry } from '@Contexts/Groups/Domain/Group/GroupAudit';

/**
 * Groups' audit table (feature 28, ADR 23): one row per balance that passed to the owner when a member left, written in the leave's
 * transaction. `id` is the pass's own identity, so a pass written twice meets the primary key. `seq` keeps the entries in the order written.
 */
export const groupAuditTablesSchema = [
  `CREATE TABLE IF NOT EXISTS group_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     group_id TEXT NOT NULL REFERENCES groups(id),
     at TEXT NOT NULL,
     by_account_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('balance-passed')),
     subject_id TEXT NOT NULL,
     amount INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS group_audit_by_group ON group_audit (group_id, at, seq)',
];

/** The audit of the balances that passed in PostgreSQL (ADR 23): `record` writes an entry in the leave's transaction; `auditOf` reads a group's. */
export class PostgresGroupAuditLog implements IGroupAuditLog {
  constructor(private readonly database: PostgresDatabase) {}

  async record(entry: GroupAuditEntry): Promise<void> {
    await this.database.writer
      .prepare(
        `INSERT INTO group_audit (id, group_id, at, by_account_id, action, subject_id, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount);
  }
}
