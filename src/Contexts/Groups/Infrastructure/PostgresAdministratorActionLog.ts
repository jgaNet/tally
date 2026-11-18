import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { AccountActionEntry, IAdministratorActionLog } from '@Contexts/Groups/Application/IAdministratorActionLog';

/**
 * Groups' part of the administrators' log, in its table (request 34, ADR 29): one row per suspension or reinstatement, written in the transaction
 * of the change. `id` is the entry's own identity, so an entry written twice meets the primary key. `seq` keeps the entries in the order written.
 */
export const administratorActionTablesSchema = [
  `CREATE TABLE IF NOT EXISTS administrator_actions (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     at TEXT NOT NULL,
     by_account_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('suspended', 'reinstated')),
     subject_id TEXT NOT NULL
   )`,
];

interface ActionRow {
  id: string;
  at: string;
  by_account_id: string;
  action: AccountActionEntry['action'];
  subject_id: string;
}

/** The administrators' log's entries of Groups, in PostgreSQL (request 34): `record` writes one in the change's transaction; `actions` reads them. */
export class PostgresAdministratorActionLog implements IAdministratorActionLog {
  constructor(private readonly database: PostgresDatabase) {}

  async record(entry: AccountActionEntry): Promise<void> {
    await this.database.writer
      .prepare('INSERT INTO administrator_actions (id, at, by_account_id, action, subject_id) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.at, entry.by, entry.action, entry.subjectId);
  }

  async actions(): Promise<AccountActionEntry[]> {
    const rows = (await this.database.read(db =>
      db.prepare('SELECT id, at, by_account_id, action, subject_id FROM administrator_actions ORDER BY at, seq').all(),
    )) as unknown as ActionRow[];
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_account_id,
      action: row.action,
      subjectId: row.subject_id,
    }));
  }
}
