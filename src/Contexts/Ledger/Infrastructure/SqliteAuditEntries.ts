import { DatabaseSync } from 'node:sqlite';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { AuditAction, AuditEntryView } from '@Contexts/Ledger/Domain/Audit/DTOs';
import { IAuditQueries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditQueries';

/**
 * The audit's table of the expenses' changes (request 28, docs/adr/0027): one row per entry, written by the expense's store in the
 * transaction of the change, and never changed. Ordered by the time of the change, then by the order rows were written.
 */
export const LEDGER_AUDIT_SCHEMA =
  'CREATE TABLE IF NOT EXISTS audit_entries (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL)';

/** Makes the audit's table what the stores read: created once, with the file. */
export function prepareAuditSchema(connection: DatabaseSync): void {
  connection.exec(LEDGER_AUDIT_SCHEMA);
}

/** Writes the entries of a group's changes, in the transaction of the change: the store calls it after its own write succeeded. */
export function recordAudit(connection: DatabaseSync, groupId: string, entries: readonly AuditEntryView[]): void {
  const insert = connection.prepare(
    'INSERT INTO audit_entries (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const entry of entries) {
    insert.run(entry.id, groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount);
  }
}

/** The read side of Ledger's audit over SQLite: reads of the file, taken alone, outside any transaction (request 28). */
export class SqliteAuditQueries implements IAuditQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareAuditSchema);
  }

  async entriesOf(groupId: string): Promise<AuditEntryView[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare(
            'SELECT id, at, by_id, action, subject_id, amount FROM audit_entries WHERE group_id = ? ORDER BY at, rowid',
          )
          .all(groupId) as Array<{
          id: string;
          at: string;
          by_id: string;
          action: string;
          subject_id: string;
          amount: number;
        }>
      ).map((row): AuditEntryView => ({
        id: String(row.id),
        at: String(row.at),
        by: String(row.by_id),
        action: String(row.action) as AuditAction,
        subjectId: String(row.subject_id),
        amount: Number(row.amount),
      })),
    );
  }
}
