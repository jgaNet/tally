import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISettlementAuditLog } from '@Contexts/Settlements/Application/ISettlementAuditLog';
import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';

/**
 * Settlements' audit table (feature 28, ADR 23): one row per change of a settlement's money, written in the change's transaction. `id` is the
 * change's own identity, so a change written twice meets the primary key. `seq` keeps the entries in the order they were written.
 */
export const settlementAuditTablesSchema = [
  `CREATE TABLE IF NOT EXISTS settlement_audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     group_id TEXT NOT NULL REFERENCES groups(id),
     at TEXT NOT NULL,
     by_account_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('settlement-paid', 'settlement-refunded', 'settlement-contested')),
     subject_id TEXT NOT NULL,
     amount INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS settlement_audit_by_group ON settlement_audit (group_id, at, seq)',
];

/** The audit of the settlements' changes in PostgreSQL (ADR 23): `record` writes an entry in the transaction of its change. */
export class PostgresSettlementAuditLog implements ISettlementAuditLog {
  constructor(private readonly database: PostgresDatabase) {}

  async record(entry: SettlementAuditEntry): Promise<void> {
    await this.database.writer
      .prepare(
        `INSERT INTO settlement_audit (id, group_id, at, by_account_id, action, subject_id, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount);
  }
}
